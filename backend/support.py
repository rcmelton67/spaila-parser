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

import base64
import json
import logging
import mimetypes
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
    """Resolve support_reports path from workspace config — called dynamically, never cached."""
    try:
        return get_workspace_dirs()["SupportReports"]
    except Exception:
        # Emergency fallback mirrors workspace_paths default — avoids writing to repo root
        return Path.home() / "Spaila" / ".spaila_internal" / "support_reports"


def _migrate_backend_fallback_reports() -> None:
    """One-time startup migration: move reports saved at the old repo-root fallback path
    (a legacy artifact from early builds where get_workspace_dirs() failed at import time).
    Safe to call repeatedly — exits immediately if the source doesn't exist.
    """
    fallback = Path(__file__).resolve().parent.parent / "support_reports"
    if not fallback.exists():
        return
    try:
        target = _support_reports_base()
        if fallback.resolve() == target.resolve():
            return
        target.mkdir(parents=True, exist_ok=True)
        migrated = 0
        for item in sorted(fallback.rglob("*")):
            if item.is_file():
                rel = item.relative_to(fallback)
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    item.rename(dest)
                    migrated += 1
        if migrated:
            log.info("support: migrated %d report(s) from repo-root fallback → %s", migrated, target)
        # Clean up empty dirs from the old location
        for d in sorted(fallback.rglob("*"), reverse=True):
            try:
                if d.is_dir():
                    d.rmdir()
            except OSError:
                pass
        try:
            fallback.rmdir()
        except OSError:
            pass
    except Exception as exc:
        log.debug("support: skipping repo-root fallback migration: %s", exc)


# Run migration once at module load (lightweight, idempotent)
try:
    _migrate_backend_fallback_reports()
except Exception:
    pass

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
MAX_SCREENSHOTS = 5
MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024

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
    billing_state = str(raw.get("billing_state") or raw.get("billing_status") or raw.get("subscription_state") or "").strip()[:50] or None
    trial_expired_raw = raw.get("trial_expired")
    trial_days = raw.get("trial_days_remaining")
    trial_expired = bool(trial_expired_raw) if trial_expired_raw is not None else (
        isinstance(trial_days, (int, float)) and int(trial_days) <= 0 and bool(raw.get("trial_active")) is False
    )
    return {
        "account_id":           str(raw.get("account_id") or raw.get("id") or "")[:64] or None,
        "email":                str(raw.get("email") or raw.get("account_email") or "")[:200] or None,
        "display_name":         str(raw.get("display_name") or raw.get("shop_name") or raw.get("owner_name") or "")[:200] or None,
        "subscription_state":   str(raw.get("subscription_state") or raw.get("plan") or "")[:50] or None,
        "trial_active":         bool(raw["trial_active"]) if "trial_active" in raw else None,
        "trial_days_remaining": (int(raw["trial_days_remaining"]) if isinstance(raw.get("trial_days_remaining"), (int, float)) else None),
        "entitlement_state":    str(raw.get("entitlement_state") or "")[:50] or None,
        "billing_state":        billing_state,
        "payment_failed":       bool(raw.get("payment_failed") or raw.get("past_due")),
        "trial_expired":        trial_expired,
        "canceled":             bool(raw.get("canceled") or raw.get("cancelled")),
        "billing_retry":        bool(raw.get("billing_retry") or raw.get("retrying_payment")),
        "subscription_locked":  bool(raw.get("subscription_locked") or raw.get("locked")),
    }


# ── Storage ───────────────────────────────────────────────────────────────────

def _internal_dir() -> Path:
    try:
        return get_workspace_dirs()["Internal"]
    except Exception:
        return Path.home() / "Spaila" / ".spaila_internal"


def _ticket_counter_path() -> Path:
    return _internal_dir() / "support_ticket_counter.json"


def _write_json_atomic(path_: Path, data: dict) -> None:
    path_.parent.mkdir(parents=True, exist_ok=True)
    tmp = path_.with_name(f"{path_.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path_)


def _next_ticket_id(received_at: str) -> str:
    try:
        year = datetime.fromisoformat(received_at).year
    except Exception:
        year = datetime.now(timezone.utc).year
    counter_path = _ticket_counter_path()
    try:
        data = json.loads(counter_path.read_text(encoding="utf-8")) if counter_path.exists() else {}
    except Exception:
        data = {}
    counters = data.get("years") if isinstance(data.get("years"), dict) else {}
    next_num = int(counters.get(str(year), 0) or 0) + 1
    counters[str(year)] = next_num
    _write_json_atomic(counter_path, {
        "schema_version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "years": counters,
    })
    return f"SPA-{year}-{next_num:06d}"


def _billing_flags(user: dict, payload: dict) -> dict:
    raw = payload.get("billing") if isinstance(payload.get("billing"), dict) else {}
    state = str(raw.get("state") or user.get("billing_state") or user.get("subscription_state") or "unknown").strip().lower()
    trial_active = bool(user.get("trial_active"))
    flags = {
        "state": state,
        "active": state in {"active", "trial"} or trial_active,
        "trial_active": trial_active,
        "trial_expired": bool(raw.get("trial_expired") or user.get("trial_expired")),
        "payment_failed": bool(raw.get("payment_failed") or user.get("payment_failed") or state in {"past_due", "payment_failed"}),
        "canceled": bool(raw.get("canceled") or user.get("canceled") or state in {"canceled", "cancelled"}),
        "billing_retry": bool(raw.get("billing_retry") or user.get("billing_retry") or state in {"retrying", "billing_retry"}),
        "subscription_locked": bool(raw.get("subscription_locked") or user.get("subscription_locked") or state in {"locked", "subscription_locked"}),
    }
    return flags


def _safe_filename(value: str, fallback: str = "attachment") -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._")
    return clean[:120] or fallback


def _decode_data_url(value: str) -> tuple[bytes, str]:
    raw = str(value or "")
    mime = "application/octet-stream"
    if raw.startswith("data:") and "," in raw:
        header, b64 = raw.split(",", 1)
        mime = header[5:].split(";")[0] or mime
    else:
        b64 = raw
    return base64.b64decode(b64, validate=True), mime


def _save_screenshots(raw_screenshots, ticket_id: str, report_id: str) -> list[dict]:
    if not isinstance(raw_screenshots, list):
        return []
    attachments_dir = _support_reports_base() / "attachments" / ticket_id
    saved: list[dict] = []
    for idx, item in enumerate(raw_screenshots[:MAX_SCREENSHOTS], start=1):
        if not isinstance(item, dict):
            continue
        try:
            blob, detected_mime = _decode_data_url(item.get("data") or item.get("data_url") or item.get("base64") or "")
            if not blob or len(blob) > MAX_SCREENSHOT_BYTES:
                continue
            mime = str(item.get("mime") or item.get("type") or detected_mime or "image/png").split(";")[0]
            if not mime.startswith("image/"):
                continue
            ext = mimetypes.guess_extension(mime) or ".png"
            original = _safe_filename(item.get("name") or f"screenshot-{idx}{ext}", f"screenshot-{idx}{ext}")
            stem = Path(original).stem or f"screenshot-{idx}"
            filename = _safe_filename(f"{idx:02d}_{stem}{ext}", f"screenshot-{idx}{ext}")
            target = attachments_dir / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            suffix = 1
            while target.exists():
                target = attachments_dir / _safe_filename(f"{idx:02d}_{stem}_{suffix}{ext}", f"screenshot-{idx}-{suffix}{ext}")
                suffix += 1
            target.write_bytes(blob)
            saved.append({
                "type": "screenshot",
                "name": original,
                "filename": target.name,
                "mime": mime,
                "size": len(blob),
                "path": str(target),
                "relative_path": str(target.relative_to(_support_reports_base())),
                "ticket_id": ticket_id,
                "report_id": report_id,
            })
        except Exception as exc:
            log.info("support screenshot skipped: %s", exc)
    return saved

def _report_path(received_at: str, report_type: str, report_id: str) -> Path:
    base = _support_reports_base()
    try:
        dt = datetime.fromisoformat(received_at)
        month_dir = base / str(dt.year) / f"{dt.month:02d}"
    except Exception:
        month_dir = base / "unknown"
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
    ticket_id   = report.get("ticket_id") or report.get("report_id", "")
    billing     = report.get("billing") or {}
    severity    = report.get("severity", "normal").upper()
    type_label  = _type_label(report.get("type", "support_request"))
    screen      = context.get("screen") or context.get("route") or "—"
    report_id   = report.get("report_id", "")
    received_at = report.get("received_at", "")
    user_lookup_err = report.get("user_lookup_error") or ""

    subject_line = (
        f"[Spaila Support] [{ticket_id}] [{severity}] {type_label} — "
        f"{report.get('subject', '(no subject)')[:80]}"
    )

    html = f"""<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#1e293b;line-height:1.6">
<h2 style="color:#1d4ed8;margin-bottom:4px">{type_label} — {severity}</h2>
<p style="color:#64748b;margin-top:0">{received_at}</p>
<table style="border-collapse:collapse;width:100%;max-width:640px">
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0;width:160px">Ticket ID</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0"><code>{ticket_id}</code></td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Report ID</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0"><code>{report_id}</code></td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">User</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{user_name} &lt;{user_email}&gt;</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Account ID</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0"><code>{acct_id}</code></td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Subscription</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{sub_state}</td></tr>
  <tr><th align="left" style="padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0">Billing</th>
      <td style="padding:6px 12px;border:1px solid #e2e8f0">{billing.get('state', 'unknown')}</td></tr>
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

    attachments = report.get("attachments") or []
    if attachments:
        html += f"""
<h3 style="margin-top:20px">Attachments</h3>
<p style="background:#f8fafc;border-left:4px solid #2563eb;padding:10px 14px;margin:0">
  {len(attachments)} screenshot/attachment file(s) saved with this report.
</p>"""

    html += f"""
<p style="color:#94a3b8;font-size:12px;margin-top:32px">
  Ticket ID: <code>{report.get('ticket_id') or report.get('report_id', '')}</code><br>
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

    # Attach screenshots as evidence, keeping paths inside the internal workspace.
    for item in report.get("attachments") or []:
        try:
            attachment_path = Path(str(item.get("path") or ""))
            if not attachment_path.is_file():
                continue
            maintype, subtype = (str(item.get("mime") or "application/octet-stream").split("/", 1) + ["octet-stream"])[:2]
            part = MIMEBase(maintype, subtype)
            part.set_payload(attachment_path.read_bytes())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=item.get("filename") or attachment_path.name)
            msg.attach(part)
        except Exception as attach_err:
            log.warning("support email screenshot attach: %s", attach_err)

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
        ticket_id   = _next_ticket_id(received_at)

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
        billing          = _billing_flags(user, payload)
        screenshots      = _save_screenshots(payload.get("screenshots"), ticket_id, report_id)
        parser_context   = _redact(payload.get("parser") or payload.get("parser_context") or {})

        report: dict = {
            "schema_version":      3,
            "ticket_id":           ticket_id,
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
            "billing":            billing,
            "context":            context,
            "diagnostics":        diagnostics,
            "parser":             parser_context,
            "attachments":         screenshots,
            "dashboard": {
                "status":             "open",
                "tags":               [],
                "assigned_to":        None,
                "notes":              [],
                "resolved_at":        None,
                "escalated":          severity == "blocking",
                "escalated_at":       received_at if severity == "blocking" else None,
                "escalation_reason":  "Initial blocking severity" if severity == "blocking" else None,
                "customer_contacted": False,
                "awaiting_response":  False,
                "follow_up_required": False,
                "contactable":        bool(user.get("email")),
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
            "ticket_id":   ticket_id,
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
        base = _support_reports_base()
        reports = []
        if not base.exists():
            return {"reports": [], "folder": str(base.resolve())}

        for json_file in sorted(base.rglob("*.json"), reverse=True):
            if len(reports) >= limit:
                break
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                dashboard = data.get("dashboard") or {}
                billing = data.get("billing") or {}
                reports.append({
                    "filename":    json_file.name,
                    "filepath":    str(json_file),
                    "ticket_id":   data.get("ticket_id", ""),
                    "report_id":   data.get("report_id", ""),
                    "received_at": data.get("received_at", ""),
                    "type":        data.get("type", ""),
                    "severity":    data.get("severity", ""),
                    "subject":     data.get("subject", ""),
                    "app_source":  data.get("app_source", ""),
                    "user_email":  (data.get("user") or {}).get("email"),
                    "screen":      (data.get("context") or {}).get("screen") or (data.get("context") or {}).get("route", ""),
                    "status":      dashboard.get("status", "open"),
                    "escalated":   bool(dashboard.get("escalated")),
                    "billing_state": billing.get("state"),
                    "billing_flags": billing,
                    "attachment_count": len(data.get("attachments") or []),
                    "email_sent":  (data.get("notification") or {}).get("email_sent"),
                })
            except Exception:
                pass

        return {"reports": reports, "total": len(reports), "folder": str(base.resolve())}
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
        "reports_folder":           str(_support_reports_base().resolve()),
    }
