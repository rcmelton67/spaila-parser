"""Support / bug-report intake endpoint — production MVP.

Pipeline per submission:
  1. Validate + sanitise payload
  2. Redact secrets server-side
  3. Persist report as JSON under support_reports/YYYY/MM/
  4. Attempt email notification (best-effort; never blocks user)
  5. Update saved JSON with notification outcome
  6. Return full status including notification result

Endpoints:
  POST /support/report       — submit a bug report / support request
  GET  /support/test-email   — test SMTP connectivity
  GET  /support/reports      — list saved reports (newest first)
  GET  /support/config       — show SMTP config status (no secrets)
"""

import json
import logging
import os
import re
import smtplib
import uuid
from datetime import datetime, timezone
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from fastapi import APIRouter
from workspace_paths import get_workspace_dirs

log = logging.getLogger(__name__)

router = APIRouter()

# ── Configuration ─────────────────────────────────────────────────────────────

def _env(key: str, default: str = "") -> str:
    return str(os.environ.get(key) or default).strip()


def _support_reports_base() -> Path:
    """Lazily resolve support_reports path from workspace config (avoids import-time side effects)."""
    try:
        return get_workspace_dirs()["SupportReports"]
    except Exception:
        # Fallback: adjacent to repo root (previous default) so existing reports are still found
        return Path(__file__).resolve().parent.parent / "support_reports"

SUPPORT_REPORTS_BASE: Path = _support_reports_base()

# SMTP config is read lazily at call time (not at import) so that backend/.env
# loaded by account.py's _load_backend_env() is already in os.environ.
def _smtp_cfg() -> dict:
    notify  = _env("SUPPORT_NOTIFY_EMAIL", "rodney@meltonmemorials.com")
    host    = _env("SMTP_HOST")
    port    = int(_env("SMTP_PORT", "587") or 587)
    user    = _env("SMTP_USERNAME")
    pwd     = _env("SMTP_PASSWORD")
    frm     = _env("SMTP_FROM") or user or "noreply@spaila.com"
    enabled = bool(host and user and pwd)
    return {"notify": notify, "host": host, "port": port, "user": user,
            "pwd": pwd, "frm": frm, "enabled": enabled}


# Kept as module-level aliases for backward compat — overridden at call time
NOTIFY_EMAIL  = _env("SUPPORT_NOTIFY_EMAIL", "rodney@meltonmemorials.com")
SMTP_ENABLED  = False  # rechecked lazily

# ── Validation constants ──────────────────────────────────────────────────────

SEVERITY_VALUES = {"low", "normal", "high", "blocking"}
TYPE_VALUES     = {"bug_report", "support_request", "feature_request", "billing_help"}

# ── Redaction ─────────────────────────────────────────────────────────────────

_SENSITIVE_KEYS = re.compile(
    r"(password|passwd|pass|token|secret|api[_\s]?key|access[_\s]?key|"
    r"private[_\s]?key|cookie|set-cookie|authorization|auth|bearer|"
    r"stripe|webhook|signing|session|credential|client[_\s]?secret|"
    r"refresh[_\s]?token|id[_\s]?token|jwt|hmac|hash|salt|nonce)",
    re.IGNORECASE,
)
_SENSITIVE_VALUE_PATTERNS = [
    re.compile(r"sk_(?:live|test)_[A-Za-z0-9]+"),
    re.compile(r"pk_(?:live|test)_[A-Za-z0-9]+"),
    re.compile(r"whsec_[A-Za-z0-9]+"),
    re.compile(r"Bearer\s+\S+"),
    re.compile(r"Basic\s+[A-Za-z0-9+/=]+"),
    re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
]


def _redact(obj, depth: int = 0):
    if depth > 12:
        return obj
    if isinstance(obj, dict):
        return {
            k: "[REDACTED]" if _SENSITIVE_KEYS.search(str(k)) else _redact(v, depth + 1)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_redact(item, depth + 1) for item in obj[:100]]
    if isinstance(obj, str):
        result = obj
        for pat in _SENSITIVE_VALUE_PATTERNS:
            result = pat.sub("[REDACTED]", result)
        return result
    return obj


# ── Safe user block ───────────────────────────────────────────────────────────

def _safe_user(raw: dict) -> dict:
    if not isinstance(raw, dict):
        return {}
    return {
        "account_id":           str(raw.get("account_id") or raw.get("id") or "")[:64] or None,
        "email":                str(raw.get("email") or raw.get("account_email") or "")[:200] or None,
        "display_name":         str(raw.get("display_name") or raw.get("shop_name") or raw.get("owner_name") or "")[:200] or None,
        "subscription_state":   str(raw.get("subscription_state") or raw.get("plan") or "")[:50] or None,
        "trial_active":         bool(raw["trial_active"]) if "trial_active" in raw else None,
        "trial_days_remaining": (int(raw["trial_days_remaining"]) if isinstance(raw.get("trial_days_remaining"), (int, float)) else None),
        "entitlement_state":    str(raw.get("entitlement_state") or "")[:50] or None,
    }


# ── Storage ───────────────────────────────────────────────────────────────────

def _report_path(received_at: str, report_type: str, report_id: str) -> Path:
    try:
        dt = datetime.fromisoformat(received_at)
        month_dir = SUPPORT_REPORTS_BASE / str(dt.year) / f"{dt.month:02d}"
    except Exception:
        month_dir = SUPPORT_REPORTS_BASE / "unknown"
    month_dir.mkdir(parents=True, exist_ok=True)
    ts_safe = received_at.replace(":", "-").replace(".", "-")[:19]
    return month_dir / f"{ts_safe}_{report_type}_{report_id[:8]}.json"


# ── Email ─────────────────────────────────────────────────────────────────────

def _type_label(t: str) -> str:
    return {"bug_report": "Bug Report", "support_request": "Support Request",
            "feature_request": "Feature Request", "billing_help": "Billing Help"}.get(
        t, t.replace("_", " ").title()
    )


def _build_email_message(report: dict, report_path: Path, cfg: dict | None = None) -> MIMEMultipart:
    if cfg is None:
        cfg = _smtp_cfg()
    user        = report.get("user") or {}
    context     = report.get("context") or {}
    user_email  = user.get("email") or "unknown"
    user_name   = user.get("display_name") or user_email
    sub_state   = user.get("subscription_state") or "unknown"
    acct_id     = user.get("account_id") or "—"
    severity    = report.get("severity", "normal").upper()
    type_label  = _type_label(report.get("type", "support_request"))
    screen      = context.get("screen") or context.get("route") or "—"
    report_id   = report.get("report_id", "")
    received_at = report.get("received_at", "")
    user_lookup_err = report.get("user_lookup_error") or ""

    subject_line = (
        f"[Spaila Support] [{severity}] {type_label} — "
        f"{report.get('subject', '(no subject)')[:80]}"
    )

    html = f"""<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#1e293b;line-height:1.6">
<h2 style="color:#1d4ed8;margin-bottom:4px">{type_label} — {severity}</h2>
<p style="color:#64748b;margin-top:0">{received_at}</p>
<table style="border-collapse:collapse;width:100%;max-width:640px">
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0;width:160px">Report ID</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0"><code>{report_id}</code></td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">User</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{user_name} &lt;{user_email}&gt;</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Account ID</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0"><code>{acct_id}</code></td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Subscription</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{sub_state}</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">App source</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{report.get('app_source', '—')}</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Screen</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{screen}</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Severity</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{severity}</td></tr>
  {'<tr><th align="left" style="padding:6px 12px;background:#fef9c3;border:1px solid #e2e8f0">User lookup</th><td style="padding:6px 12px;border:1px solid #e2e8f0;color:#92400e">' + user_lookup_err + "</td></tr>" if user_lookup_err else ""}
</table>
<h3 style="margin-top:24px">Subject</h3>
<p style="background:#f8fafc;border-left:4px solid #2563eb;padding:10px 14px;margin:0">{report.get('subject','')}</p>
<h3 style="margin-top:20px">Message</h3>
<pre style="background:#f8fafc;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">{report.get('message','')}</pre>"""

    if report.get("steps_to_reproduce"):
        html += f"""
<h3 style="margin-top:20px">Steps to Reproduce</h3>
<pre style="background:#f8fafc;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">{report.get('steps_to_reproduce','')}</pre>"""

    html += f"""
<p style="color:#94a3b8;font-size:12px;margin-top:32px">
  Saved: <code>{report_path}</code><br>
  Spaila support intake — auto-generated notification
</p></body></html>"""

    msg = MIMEMultipart("mixed")
    msg["From"]    = cfg["frm"]
    msg["To"]      = cfg["notify"]
    msg["Subject"] = subject_line
    msg.attach(MIMEText(html, "html"))

    # Attach JSON report file
    try:
        attachment = MIMEBase("application", "json")
        attachment.set_payload(report_path.read_bytes())
        encoders.encode_base64(attachment)
        attachment.add_header("Content-Disposition", "attachment", filename=report_path.name)
        msg.attach(attachment)
    except Exception as attach_err:
        log.warning("support email attach: %s", attach_err)

    return msg


def _try_smtp_send(cfg: dict, msg: MIMEMultipart) -> tuple[bool, str]:
    """Attempt SMTP send. Returns (success, error_message)."""
    try:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=10) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(cfg["user"], cfg["pwd"])
            smtp.sendmail(cfg["frm"], cfg["notify"], msg.as_string())
        return True, ""
    except smtplib.SMTPAuthenticationError as e:
        return False, f"SMTP authentication failed: {e.smtp_error!r}"
    except smtplib.SMTPConnectError as e:
        return False, f"SMTP connection failed: {e}"
    except smtplib.SMTPException as e:
        return False, f"SMTP error: {e}"
    except OSError as e:
        return False, f"Network error: {e}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def _send_notify_email(report: dict, report_path: Path) -> dict:
    """Send notification email. Returns notification status dict."""
    cfg = _smtp_cfg()
    notification = {
        "email_enabled":   cfg["enabled"],
        "email_attempted": False,
        "email_sent":      False,
        "email_error":     None,
        "notify_email":    cfg["notify"],
    }

    if not cfg["enabled"]:
        missing = [k for k, v in {"SMTP_HOST": cfg["host"], "SMTP_USERNAME": cfg["user"], "SMTP_PASSWORD": cfg["pwd"]}.items() if not v]
        reason = f"SMTP not configured — missing: {', '.join(missing)}"
        log.info("support email: %s", reason)
        notification["email_error"] = reason
        return notification

    notification["email_attempted"] = True
    try:
        msg = _build_email_message(report, report_path, cfg)
        success, err_msg = _try_smtp_send(cfg, msg)
        notification["email_sent"]  = success
        notification["email_error"] = err_msg if not success else None
        if success:
            log.info("support email: sent report %s to %s", report.get("report_id"), cfg["notify"])
        else:
            log.warning("support email: send failed for report %s — %s", report.get("report_id"), err_msg)
    except Exception as exc:
        notification["email_sent"]  = False
        notification["email_error"] = str(exc)
        log.warning("support email: unexpected error: %s", exc)

    return notification


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/support/report")
def submit_support_report(payload: dict):
    """Accept a support/bug report, persist it, email notify, return full status."""
    try:
        report_id   = str(uuid.uuid4())
        received_at = datetime.now(timezone.utc).isoformat()

        report_type = str(payload.get("type") or "support_request").strip().lower()
        if report_type not in TYPE_VALUES:
            report_type = "support_request"

        severity = str(payload.get("severity") or "normal").strip().lower()
        if severity not in SEVERITY_VALUES:
            severity = "normal"

        subject    = str(payload.get("subject") or "").strip()[:500]
        message    = str(payload.get("message") or "").strip()[:10000]
        steps      = str(payload.get("steps_to_reproduce") or "").strip()[:5000]
        app_source = str(payload.get("app_source") or "unknown").strip()[:50]

        user             = _safe_user(payload.get("user") or {})
        user_lookup_error = str(payload.get("user_lookup_error") or "")[:300] or None
        context          = _redact(payload.get("context") or {})
        diagnostics      = _redact(payload.get("diagnostics") or {})

        report: dict = {
            "report_id":          report_id,
            "received_at":        received_at,
            "type":               report_type,
            "severity":           severity,
            "subject":            subject,
            "message":            message,
            "steps_to_reproduce": steps,
            "app_source":         app_source,
            "user":               user,
            "user_lookup_error":  user_lookup_error,
            "context":            context,
            "diagnostics":        diagnostics,
            "dashboard": {
                "status":      "open",
                "tags":        [],
                "assigned_to": None,
                "notes":       [],
                "resolved_at": None,
            },
        }

        # 1. Save initial report
        filepath = _report_path(received_at, report_type, report_id)
        filepath.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        log.info("support: saved report %s → %s", report_id[:8], filepath)

        # 2. Email notification (best-effort)
        notification = _send_notify_email(report, filepath)

        # 3. Update saved file with notification outcome
        report["notification"] = notification
        filepath.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

        return {
            "status":      "received",
            "report_id":   report_id,
            "notification": notification,
        }

    except Exception as exc:
        log.error("support report error: %s", exc)
        return {"status": "error", "error": str(exc)[:200]}


@router.get("/support/test-email")
def test_support_email():
    """Send a test email to SUPPORT_NOTIFY_EMAIL. Used to verify SMTP config."""
    cfg = _smtp_cfg()
    config_status = {
        "smtp_host_configured":     bool(cfg["host"]),
        "smtp_username_configured": bool(cfg["user"]),
        "smtp_password_configured": bool(cfg["pwd"]),
        "notify_email":             cfg["notify"],
        "smtp_enabled":             cfg["enabled"],
    }

    if not cfg["enabled"]:
        missing = [k for k, v in {"SMTP_HOST": cfg["host"], "SMTP_USERNAME": cfg["user"], "SMTP_PASSWORD": cfg["pwd"]}.items() if not v]
        return {
            "ok": False,
            "message": f"SMTP not configured. Missing: {', '.join(missing)}. "
                       f"Set these in backend/.env and restart the backend.",
            **config_status,
        }

    try:
        test_msg = MIMEMultipart("mixed")
        test_msg["From"]    = cfg["frm"]
        test_msg["To"]      = cfg["notify"]
        test_msg["Subject"] = "[Spaila Support] Test email — SMTP config verified"
        test_msg.attach(MIMEText(
            f"""<html><body style="font-family:system-ui,sans-serif;color:#1e293b;padding:20px">
<h2 style="color:#166534">SMTP Test Successful</h2>
<p>Your Spaila support email configuration is working correctly.</p>
<p>Future support reports will be delivered to this address.</p>
<p style="color:#64748b;font-size:12px">Sent at: {datetime.now(timezone.utc).isoformat()}</p>
</body></html>""",
            "html",
        ))

        success, err_msg = _try_smtp_send(cfg, test_msg)
        if success:
            log.info("support test-email: sent to %s", cfg["notify"])
            return {"ok": True, "message": f"Test email sent to {cfg['notify']}.", **config_status}
        else:
            log.warning("support test-email: failed — %s", err_msg)
            return {"ok": False, "message": f"SMTP send failed: {err_msg}", **config_status}

    except Exception as exc:
        return {"ok": False, "message": f"Unexpected error: {exc}", **config_status}


@router.get("/support/reports")
def list_support_reports(limit: int = 100):
    """List saved support reports, newest first. Returns summary rows."""
    try:
        reports = []
        if not SUPPORT_REPORTS_BASE.exists():
            return {"reports": [], "folder": str(SUPPORT_REPORTS_BASE.resolve())}

        for json_file in sorted(SUPPORT_REPORTS_BASE.rglob("*.json"), reverse=True):
            if len(reports) >= limit:
                break
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                reports.append({
                    "filename":    json_file.name,
                    "filepath":    str(json_file),
                    "report_id":   data.get("report_id", ""),
                    "received_at": data.get("received_at", ""),
                    "type":        data.get("type", ""),
                    "severity":    data.get("severity", ""),
                    "subject":     data.get("subject", ""),
                    "app_source":  data.get("app_source", ""),
                    "user_email":  (data.get("user") or {}).get("email"),
                    "screen":      (data.get("context") or {}).get("screen") or (data.get("context") or {}).get("route", ""),
                    "status":      (data.get("dashboard") or {}).get("status", "open"),
                    "email_sent":  (data.get("notification") or {}).get("email_sent"),
                })
            except Exception:
                pass

        return {"reports": reports, "total": len(reports), "folder": str(SUPPORT_REPORTS_BASE.resolve())}
    except Exception as exc:
        return {"reports": [], "error": str(exc)[:200]}


@router.get("/support/config")
def support_config_status():
    """Return SMTP/notification config status. Never exposes passwords."""
    cfg = _smtp_cfg()
    return {
        "smtp_enabled":             cfg["enabled"],
        "smtp_host_configured":     bool(cfg["host"]),
        "smtp_port":                cfg["port"],
        "smtp_username_configured": bool(cfg["user"]),
        "smtp_from_configured":     bool(cfg["frm"]),
        "notify_email":             cfg["notify"],
        "reports_folder":           str(SUPPORT_REPORTS_BASE.resolve()),
    }
