import base64
import hashlib
import hmac
import json
import os
import secrets
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ...db import get_conn


def _load_backend_env() -> None:
    """Load backend/.env for local-first desktop/web runs.

    Stripe keys are refreshed from backend/.env on reload so local secret edits are
    picked up without keeping stale values in uvicorn's reloader process.
    """
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    refresh_keys = {
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_PRICE_ID",
        "STRIPE_WEBHOOK_SECRET",
        "SPAILA_STRIPE_PORTAL_RETURN_URL",
        "SPAILA_ACCOUNT_RETURN_URL",
    }
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and (key in refresh_keys or key not in os.environ):
                os.environ[key] = value
    except Exception:
        return


_load_backend_env()


router = APIRouter(prefix="/account", tags=["account"])

ACCOUNT_ID = "local-single-shop"
SESSION_COOKIE = "spaila_session"
TRIAL_DAYS = 7
SESSION_DAYS = 30
RESET_TOKEN_MINUTES = 30

LOCKED_FEATURES = {
    "parser",
    "inbox",
    "helper",
    "manual_order_creation",
}

GATED_CAPABILITIES = {
    "can_parse": "parser",
    "can_create_manual_orders": "manual_order_creation",
    "can_receive_email": "inbox",
    "can_use_helper": "helper",
    "can_send_email": "email_sending",
}


class AccountProfileUpdate(BaseModel):
    shop_name: str | None = Field(default=None, max_length=200)
    owner_name: str | None = Field(default=None, max_length=200)
    account_email: str | None = Field(default=None, max_length=320)
    business_timezone: str | None = Field(default=None, max_length=120)
    shop_logo_path: str | None = Field(default=None, max_length=1024)


class WebSettingsUpdate(BaseModel):
    default_order_scope: str | None = Field(default=None, max_length=40)
    default_order_sort: str | None = Field(default=None, max_length=40)
    order_density: str | None = Field(default=None, max_length=40)
    show_attachment_previews: bool | None = None
    show_completed_tab: bool | None = None
    show_inventory_tab: bool | None = None
    show_thank_you_shortcut: bool | None = None
    archive_default_status: str | None = Field(default=None, max_length=40)


class BusinessAssetUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=260)
    mime_type: str | None = Field(default=None, max_length=120)
    content_base64: str | None = None
    source_path: str | None = Field(default=None, max_length=1024)


class OrderFieldLayoutUpdate(BaseModel):
    fields: list[dict[str, Any]] | None = None
    order: list[str] | None = None
    status: dict[str, Any] | None = None
    sort_defaults: dict[str, Any] | None = None
    search_defaults: dict[str, Any] | None = None
    column_width_profiles: dict[str, Any] | None = None
    platform_overrides: dict[str, Any] | None = None
    layout_version: int | None = None


class DateConfigUpdate(BaseModel):
    format: str | None = Field(default=None, max_length=20)
    showYear: bool | None = None
    flexibleSearch: bool | None = None


class PricingRulesUpdate(BaseModel):
    rules: list[dict[str, Any]] = Field(default_factory=list)


class PrintConfigUpdate(BaseModel):
    mode: str | None = Field(default=None, max_length=20)
    orientation: str | None = Field(default=None, max_length=20)
    columns: dict[str, bool] | None = None
    wrap: dict[str, bool] | None = None
    cardOrder: list[str] | None = None


class DocumentsConfigUpdate(BaseModel):
    gift_template: dict[str, Any] | None = None
    thank_you_template: dict[str, Any] | None = None
    show_gift_print_icon: bool | None = None
    show_thank_you_shortcut: bool | None = None
    gift_text_x: float | int | None = None
    gift_text_y: float | int | None = None
    gift_text_max_width: float | int | None = None
    font_size: float | int | None = None
    text_color: str | None = Field(default=None, max_length=20)
    future_docs: dict[str, Any] | None = None
    layout_version: int | None = None


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=200)
    shop_name: str | None = Field(default=None, max_length=200)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)


class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=12, max_length=300)
    password: str = Field(min_length=8, max_length=200)


class DevSubscriptionUpdate(BaseModel):
    subscription_state: str | None = Field(default=None, max_length=40)
    plan_code: str | None = Field(default=None, max_length=40)
    trial_ends_at: str | None = Field(default=None, max_length=80)


class CheckoutRequest(BaseModel):
    success_url: str | None = Field(default=None, max_length=1024)
    cancel_url: str | None = Field(default=None, max_length=1024)


class PortalRequest(BaseModel):
    return_url: str | None = Field(default=None, max_length=1024)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except Exception:
        return None


def _stripe_ts(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()
    except Exception:
        return ""


def _stripe_status_to_subscription_state(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized == "trialing":
        return "trial"
    if normalized == "active":
        return "active"
    if normalized in {"past_due", "unpaid", "canceled", "incomplete_expired"}:
        return "past_due" if normalized in {"past_due", "unpaid"} else "canceled"
    return "setup_pending"


def _stripe_status_to_billing_status(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized == "trialing":
        return "trialing"
    if normalized == "active":
        return "active"
    if normalized in {"past_due", "unpaid"}:
        return "payment_failed"
    if normalized == "canceled":
        return "canceled"
    return normalized or "setup_pending"


def _hash_password(password: str, salt: str | None = None) -> str:
    salt_value = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        str(password).encode("utf-8"),
        salt_value.encode("utf-8"),
        240_000,
    ).hex()
    return f"pbkdf2_sha256$240000${salt_value}${digest}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, iterations, salt, expected = str(stored_hash or "").split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            str(password).encode("utf-8"),
            salt.encode("utf-8"),
            int(iterations),
        ).hex()
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _public_user(row: tuple | None) -> dict[str, Any] | None:
    if not row:
        return None
    user_id, account_id, email, name, role, created_at, last_login_at = row
    return {
        "id": user_id,
        "account_id": account_id,
        "email": email,
        "name": name or "",
        "role": role or "owner",
        "created_at": created_at or "",
        "last_login_at": last_login_at or "",
    }


def _load_user_by_email(email: str) -> tuple | None:
    normalized = str(email or "").strip().lower()
    if not normalized:
        return None
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, account_id, email, name, password_hash, role, created_at, last_login_at
            FROM account_users
            WHERE lower(email) = ?
            """,
            (normalized,),
        )
        return cur.fetchone()
    finally:
        conn.close()


def _load_user_public(user_id: str) -> dict[str, Any] | None:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, account_id, email, name, role, created_at, last_login_at
            FROM account_users
            WHERE id = ?
            """,
            (user_id,),
        )
        return _public_user(cur.fetchone())
    finally:
        conn.close()


def _session_id_from_request(request: Request | None, authorization: str | None = None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    if request is not None:
        return str(request.cookies.get(SESSION_COOKIE) or "").strip()
    return ""


def _load_session_user(session_id: str) -> dict[str, Any] | None:
    if not session_id:
        return None
    now = _now_iso()
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT user_id, account_id, expires_at, revoked_at
            FROM auth_sessions
            WHERE session_id = ?
            """,
            (session_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        user_id, _account_id, expires_at, revoked_at = row
        if revoked_at or (expires_at and expires_at <= now):
            return None
        return _load_user_public(user_id)
    finally:
        conn.close()


def _create_session(response: Response, user_id: str, account_id: str) -> str:
    session_id = secrets.token_urlsafe(36)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=SESSION_DAYS)
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO auth_sessions (session_id, user_id, account_id, created_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (session_id, user_id, account_id, now.isoformat(), expires_at.isoformat()),
        )
        conn.commit()
    finally:
        conn.close()
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=SESSION_DAYS * 24 * 60 * 60,
    )
    return session_id


def _clear_session(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE)


def _subscription_view(profile: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    state = str(profile.get("subscription_state") or "local_only").strip().lower()
    trial_ends_at = profile.get("trial_ends_at") or ""
    trial_end = _parse_iso(trial_ends_at)
    trial_expired = state == "trial" and bool(trial_end and trial_end <= now)
    billing_status = str(profile.get("billing_status") or "").strip().lower()
    active = state in {"local_only", "active"} or (state == "trial" and not trial_expired)
    if billing_status in {"payment_failed", "past_due", "unpaid", "canceled"}:
        active = False
    locked = not active
    if trial_expired:
        locked = True
    locked_features = sorted(LOCKED_FEATURES) if locked else []
    capabilities = {
        key: feature not in locked_features
        for key, feature in GATED_CAPABILITIES.items()
    }
    capabilities.update({
        "can_view_existing_orders": True,
        "can_search_archive": True,
    })
    account_status = "Local Mode" if state == "local_only" else ("Trial Expired" if trial_expired else ("Billing Issue" if billing_status in {"payment_failed", "past_due", "unpaid"} else ("Active Subscription" if state == "active" else "Free Trial" if state == "trial" else "Setup Pending")))
    return {
        "plan_code": profile.get("plan_code") or "local",
        "subscription_state": "trial_expired" if trial_expired else state,
        "account_status": account_status,
        "auth_mode": profile.get("auth_mode") or "local_first",
        "trial_started_at": profile.get("trial_started_at") or "",
        "trial_ends_at": trial_ends_at,
        "trial_start": profile.get("trial_started_at") or "",
        "trial_end": trial_ends_at,
        "trial_expired": trial_expired,
        "locked": locked,
        "locked_features": locked_features,
        "preserved_features": ["order_viewing", "archive_viewing", "settings", "billing"],
        "capabilities": capabilities,
        **capabilities,
        "billing_status": profile.get("billing_status") or "not_configured",
        "stripe_customer_id": profile.get("stripe_customer_id") or "",
        "stripe_subscription_id": profile.get("stripe_subscription_id") or "",
        "subscription_status": profile.get("subscription_status") or "",
        "subscription_current_period_end": profile.get("subscription_current_period_end") or "",
        "current_period_end": profile.get("subscription_current_period_end") or "",
        "subscription_cancel_at_period_end": bool(profile.get("subscription_cancel_at_period_end")),
        "last_payment_status": profile.get("last_payment_status") or "",
        "canceled_at": profile.get("canceled_at") or "",
    }


def _require_feature(feature: str) -> None:
    entitlements = _subscription_view(_load_profile())
    if feature in entitlements["locked_features"]:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "subscription_required",
                "feature": feature,
                "message": "Your Spaila trial has ended. Upgrade to continue using this feature.",
                "entitlements": entitlements,
            },
        )


def _billing_event_seen(event_id: str) -> bool:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM billing_events WHERE event_id = ?", (event_id,))
        return cur.fetchone() is not None
    finally:
        conn.close()


def _stripe_post(path: str, fields: dict[str, Any]) -> dict[str, Any]:
    secret_key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not secret_key:
        raise HTTPException(status_code=400, detail="Stripe secret key is not configured.")
    encoded = urllib.parse.urlencode({
        key: value
        for key, value in fields.items()
        if value is not None and str(value) != ""
    }).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.stripe.com/v1/{path.lstrip('/')}",
        data=encoded,
        headers={
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Stripe request failed: {exc}") from exc


def _billing_return_url(fallback: str = "http://127.0.0.1:5173/") -> str:
    return (
        os.environ.get("SPAILA_STRIPE_PORTAL_RETURN_URL")
        or os.environ.get("SPAILA_ACCOUNT_RETURN_URL")
        or fallback
    ).strip()


def _remaining_trial_end(profile: dict[str, Any]) -> int | None:
    trial_end = _parse_iso(profile.get("trial_ends_at"))
    if not trial_end:
        return None
    now = datetime.now(timezone.utc)
    if trial_end <= now:
        return None
    return int(trial_end.timestamp())


def _stripe_subscription_fields(data_object: dict[str, Any]) -> dict[str, Any]:
    status = str(data_object.get("status") or "").strip().lower()
    fields: dict[str, Any] = {
        "plan_code": "spaila_one",
        "subscription_status": status,
        "subscription_state": _stripe_status_to_subscription_state(status),
        "billing_status": _stripe_status_to_billing_status(status),
        "stripe_customer_id": str(data_object.get("customer") or ""),
        "stripe_subscription_id": str(data_object.get("id") or data_object.get("subscription") or ""),
        "subscription_cancel_at_period_end": bool(data_object.get("cancel_at_period_end")),
    }
    current_period_end = _stripe_ts(data_object.get("current_period_end"))
    if current_period_end:
        fields["subscription_current_period_end"] = current_period_end
    trial_start = _stripe_ts(data_object.get("trial_start"))
    trial_end = _stripe_ts(data_object.get("trial_end"))
    if trial_start:
        fields["trial_started_at"] = trial_start
    if trial_end:
        fields["trial_ends_at"] = trial_end
    canceled_at = _stripe_ts(data_object.get("canceled_at") or data_object.get("ended_at"))
    if canceled_at:
        fields["canceled_at"] = canceled_at
    return fields


def _default_order_status_layout() -> dict[str, Any]:
    return {
        "enabled": True,
        "columnLabel": "Status",
        "states": [
            {"key": "pending", "label": "Pending", "color": "#fef3c7"},
            {"key": "sent", "label": "Sent", "color": "#dbeafe"},
            {"key": "approved", "label": "Approved", "color": "#d1fae5"},
        ],
    }


def _normalize_hex_color(value: str) -> str:
    c = str(value or "").strip()
    if not c.startswith("#"):
        return "#e5e7eb"
    body = c[1:]
    hexchars = set("0123456789abcdefABCDEF")
    if len(body) == 3 and all(ch in hexchars for ch in body):
        body = "".join(ch * 2 for ch in body)
    if len(body) == 6 and all(ch in hexchars for ch in body):
        return "#" + body.lower()
    return "#e5e7eb"


def _sanitize_status_states(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for i, item in enumerate(raw[:60]):
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()[:64] or f"state-{i + 1}"
        label = str(item.get("label", "")).strip()[:120] or "State"
        color = _normalize_hex_color(str(item.get("color", "")).strip())
        out.append({"key": key, "label": label, "color": color})
    return out


def _default_profile() -> dict[str, Any]:
    now = _now_iso()
    return {
        "account_id": "local-single-shop",
        "shop_id": "local-shop",
        "shop_name": "",
        "owner_name": "",
        "account_email": "",
        "business_timezone": "",
        "shop_logo_path": "",
        "plan_code": "local",
        "subscription_state": "local_only",
        "auth_mode": "local_first",
        "multi_shop_ready": False,
        "trial_started_at": "",
        "trial_ends_at": "",
        "stripe_customer_id": "",
        "stripe_subscription_id": "",
        "subscription_status": "",
        "subscription_current_period_end": "",
        "subscription_cancel_at_period_end": False,
        "billing_status": "not_configured",
        "last_payment_status": "",
        "canceled_at": "",
        "created_at": now,
        "updated_at": now,
    }


def _coerce_profile(row: tuple | None) -> dict[str, Any]:
    profile = _default_profile()
    if not row:
        return profile
    (
        account_id,
        shop_id,
        shop_name,
        owner_name,
        account_email,
        business_timezone,
        shop_logo_path,
        plan_code,
        subscription_state,
        auth_mode,
        multi_shop_ready,
        trial_started_at,
        trial_ends_at,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        subscription_current_period_end,
        subscription_cancel_at_period_end,
        billing_status,
        last_payment_status,
        canceled_at,
        created_at,
        updated_at,
    ) = row
    profile.update({
        "account_id": account_id or profile["account_id"],
        "shop_id": shop_id or profile["shop_id"],
        "shop_name": shop_name or "",
        "owner_name": owner_name or "",
        "account_email": account_email or "",
        "business_timezone": business_timezone or "",
        "shop_logo_path": shop_logo_path or "",
        "plan_code": plan_code or "local",
        "subscription_state": subscription_state or "local_only",
        "auth_mode": auth_mode or "local_first",
        "multi_shop_ready": bool(multi_shop_ready),
        "trial_started_at": trial_started_at or "",
        "trial_ends_at": trial_ends_at or "",
        "stripe_customer_id": stripe_customer_id or "",
        "stripe_subscription_id": stripe_subscription_id or "",
        "subscription_status": subscription_status or "",
        "subscription_current_period_end": subscription_current_period_end or "",
        "subscription_cancel_at_period_end": bool(subscription_cancel_at_period_end),
        "billing_status": billing_status or "not_configured",
        "last_payment_status": last_payment_status or "",
        "canceled_at": canceled_at or "",
        "created_at": created_at or profile["created_at"],
        "updated_at": updated_at or profile["updated_at"],
    })
    return profile


def _load_profile() -> dict[str, Any]:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT account_id, shop_id, shop_name, owner_name, account_email,
                   business_timezone, shop_logo_path, plan_code, subscription_state,
                   auth_mode, multi_shop_ready, trial_started_at, trial_ends_at,
                   stripe_customer_id, stripe_subscription_id, subscription_status,
                   subscription_current_period_end, subscription_cancel_at_period_end,
                   billing_status, last_payment_status, canceled_at, created_at, updated_at
            FROM account_profiles
            WHERE account_id = ?
            """,
            (ACCOUNT_ID,),
        )
        return _coerce_profile(cur.fetchone())
    finally:
        conn.close()


def _save_profile(patch: AccountProfileUpdate) -> dict[str, Any]:
    current = _load_profile()
    updates = patch.model_dump(exclude_unset=True)
    for key, value in updates.items():
        current[key] = "" if value is None else str(value).strip()
    current["updated_at"] = _now_iso()

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO account_profiles (
                account_id, shop_id, shop_name, owner_name, account_email,
                business_timezone, shop_logo_path, plan_code, subscription_state,
                auth_mode, multi_shop_ready, trial_started_at, trial_ends_at,
                stripe_customer_id, stripe_subscription_id, subscription_status,
                subscription_current_period_end, subscription_cancel_at_period_end,
                billing_status, last_payment_status, canceled_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                shop_name = excluded.shop_name,
                owner_name = excluded.owner_name,
                account_email = excluded.account_email,
                business_timezone = excluded.business_timezone,
                shop_logo_path = excluded.shop_logo_path,
                updated_at = excluded.updated_at
            """,
            (
                current["account_id"],
                current["shop_id"],
                current["shop_name"],
                current["owner_name"],
                current["account_email"],
                current["business_timezone"],
                current["shop_logo_path"],
                current["plan_code"],
                current["subscription_state"],
                current["auth_mode"],
                1 if current["multi_shop_ready"] else 0,
                current["trial_started_at"],
                current["trial_ends_at"],
                current["stripe_customer_id"],
                current["stripe_subscription_id"],
                current["subscription_status"],
                current["subscription_current_period_end"],
                1 if current["subscription_cancel_at_period_end"] else 0,
                current["billing_status"],
                current["last_payment_status"],
                current["canceled_at"],
                current["created_at"],
                current["updated_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return current


def _save_commercial_profile_fields(fields: dict[str, Any]) -> dict[str, Any]:
    current = _load_profile()
    now = _now_iso()
    current.update(fields)
    current["updated_at"] = now
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO account_profiles (
                account_id, shop_id, shop_name, owner_name, account_email,
                business_timezone, shop_logo_path, plan_code, subscription_state,
                auth_mode, multi_shop_ready, trial_started_at, trial_ends_at,
                stripe_customer_id, stripe_subscription_id, subscription_status,
                subscription_current_period_end, subscription_cancel_at_period_end,
                billing_status, last_payment_status, canceled_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                shop_name = excluded.shop_name,
                owner_name = excluded.owner_name,
                account_email = excluded.account_email,
                plan_code = excluded.plan_code,
                subscription_state = excluded.subscription_state,
                auth_mode = excluded.auth_mode,
                multi_shop_ready = excluded.multi_shop_ready,
                trial_started_at = excluded.trial_started_at,
                trial_ends_at = excluded.trial_ends_at,
                stripe_customer_id = excluded.stripe_customer_id,
                stripe_subscription_id = excluded.stripe_subscription_id,
                subscription_status = excluded.subscription_status,
                subscription_current_period_end = excluded.subscription_current_period_end,
                subscription_cancel_at_period_end = excluded.subscription_cancel_at_period_end,
                billing_status = excluded.billing_status,
                last_payment_status = excluded.last_payment_status,
                canceled_at = excluded.canceled_at,
                updated_at = excluded.updated_at
            """,
            (
                current["account_id"],
                current["shop_id"],
                current["shop_name"],
                current["owner_name"],
                current["account_email"],
                current["business_timezone"],
                current["shop_logo_path"],
                current["plan_code"],
                current["subscription_state"],
                current["auth_mode"],
                1 if current["multi_shop_ready"] else 0,
                current["trial_started_at"],
                current["trial_ends_at"],
                current["stripe_customer_id"],
                current["stripe_subscription_id"],
                current["subscription_status"],
                current["subscription_current_period_end"],
                1 if current["subscription_cancel_at_period_end"] else 0,
                current["billing_status"],
                current["last_payment_status"],
                current["canceled_at"],
                current["created_at"],
                current["updated_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return current


def _default_web_settings() -> dict[str, Any]:
    now = _now_iso()
    return {
        "account_id": "local-single-shop",
        "default_order_scope": "active",
        "default_order_sort": "newest",
        "order_density": "comfortable",
        "show_attachment_previews": True,
        "show_completed_tab": True,
        "show_inventory_tab": False,
        "show_thank_you_shortcut": True,
        "archive_default_status": "archived",
        "created_at": now,
        "updated_at": now,
    }


def _coerce_web_settings(row: tuple | None) -> dict[str, Any]:
    settings = _default_web_settings()
    if not row:
        return settings
    (
        account_id,
        default_order_scope,
        default_order_sort,
        order_density,
        show_attachment_previews,
        show_completed_tab,
        show_inventory_tab,
        show_thank_you_shortcut,
        archive_default_status,
        created_at,
        updated_at,
    ) = row
    settings.update({
        "account_id": account_id or settings["account_id"],
        "default_order_scope": default_order_scope or settings["default_order_scope"],
        "default_order_sort": default_order_sort or settings["default_order_sort"],
        "order_density": order_density or settings["order_density"],
        "show_attachment_previews": bool(show_attachment_previews),
        "show_completed_tab": bool(show_completed_tab) if show_completed_tab is not None else True,
        "show_inventory_tab": bool(show_inventory_tab) if show_inventory_tab is not None else False,
        "show_thank_you_shortcut": bool(show_thank_you_shortcut) if show_thank_you_shortcut is not None else True,
        "archive_default_status": archive_default_status or settings["archive_default_status"],
        "created_at": created_at or settings["created_at"],
        "updated_at": updated_at or settings["updated_at"],
    })
    return settings


def _load_web_settings() -> dict[str, Any]:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT account_id, default_order_scope, default_order_sort, order_density,
                   show_attachment_previews, show_completed_tab, show_inventory_tab, show_thank_you_shortcut,
                   archive_default_status, created_at, updated_at
            FROM web_settings
            WHERE account_id = ?
            """,
            ("local-single-shop",),
        )
        return _coerce_web_settings(cur.fetchone())
    finally:
        conn.close()


def _save_web_settings(patch: WebSettingsUpdate) -> dict[str, Any]:
    current = _load_web_settings()
    updates = patch.model_dump(exclude_unset=True)
    text_fields = {"default_order_scope", "default_order_sort", "order_density", "archive_default_status"}
    bool_fields = {"show_attachment_previews", "show_completed_tab", "show_inventory_tab", "show_thank_you_shortcut"}
    for key, value in updates.items():
        if key in text_fields:
            current[key] = str(value or "").strip() or current[key]
        elif key in bool_fields and value is not None:
            current[key] = bool(value)
    current["updated_at"] = _now_iso()

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO web_settings (
                account_id, default_order_scope, default_order_sort, order_density,
                show_attachment_previews, show_completed_tab, show_inventory_tab, show_thank_you_shortcut,
                archive_default_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
                default_order_scope = excluded.default_order_scope,
                default_order_sort = excluded.default_order_sort,
                order_density = excluded.order_density,
                show_attachment_previews = excluded.show_attachment_previews,
                show_completed_tab = excluded.show_completed_tab,
                show_inventory_tab = excluded.show_inventory_tab,
                show_thank_you_shortcut = excluded.show_thank_you_shortcut,
                archive_default_status = excluded.archive_default_status,
                updated_at = excluded.updated_at
            """,
            (
                current["account_id"],
                current["default_order_scope"],
                current["default_order_sort"],
                current["order_density"],
                1 if current["show_attachment_previews"] else 0,
                1 if current["show_completed_tab"] else 0,
                1 if current["show_inventory_tab"] else 0,
                1 if current["show_thank_you_shortcut"] else 0,
                current["archive_default_status"],
                current["created_at"],
                current["updated_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return current


def _load_business_asset(asset_key: str) -> dict[str, Any] | None:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT account_id, asset_key, name, mime_type, content_base64,
                   source_path, created_at, updated_at
            FROM business_assets
            WHERE account_id = ? AND asset_key = ?
            """,
            ("local-single-shop", asset_key),
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None
    account_id, key, name, mime_type, content_base64, source_path, created_at, updated_at = row
    return {
        "account_id": account_id,
        "asset_key": key,
        "name": name or "",
        "mime_type": mime_type or "application/octet-stream",
        "content_base64": content_base64 or "",
        "source_path": source_path or "",
        "created_at": created_at or "",
        "updated_at": updated_at or "",
    }


def _save_business_asset(asset_key: str, patch: BusinessAssetUpdate) -> dict[str, Any]:
    current = _load_business_asset(asset_key) or {
        "account_id": "local-single-shop",
        "asset_key": asset_key,
        "name": "",
        "mime_type": "application/octet-stream",
        "content_base64": "",
        "source_path": "",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    updates = patch.model_dump(exclude_unset=True)
    for key, value in updates.items():
        current[key] = "" if value is None else str(value).strip()
    current["updated_at"] = _now_iso()

    # Validate base64 early so corrupted imports fail before persisting.
    if current["content_base64"]:
        try:
            base64.b64decode(current["content_base64"], validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid asset content encoding.") from exc

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO business_assets (
                account_id, asset_key, name, mime_type, content_base64,
                source_path, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, asset_key) DO UPDATE SET
                name = excluded.name,
                mime_type = excluded.mime_type,
                content_base64 = excluded.content_base64,
                source_path = excluded.source_path,
                updated_at = excluded.updated_at
            """,
            (
                current["account_id"],
                current["asset_key"],
                current["name"],
                current["mime_type"],
                current["content_base64"],
                current["source_path"],
                current["created_at"],
                current["updated_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return current


def _asset_metadata(asset: dict[str, Any]) -> dict[str, Any]:
    content = asset.get("content_base64", "")
    size = 0
    if content:
        try:
            size = len(base64.b64decode(content))
        except Exception:
            size = 0
    return {
        "asset_key": asset.get("asset_key", ""),
        "name": asset.get("name", ""),
        "mime_type": asset.get("mime_type", "application/octet-stream"),
        "size": size,
        "updated_at": asset.get("updated_at", ""),
        "preview_url": "/account/thank-you-template/file",
        "print_url": "/account/thank-you-template/file",
    }


def _load_json_asset(asset_key: str) -> dict[str, Any] | None:
    asset = _load_business_asset(asset_key)
    if not asset or not asset.get("content_base64"):
        return None
    try:
        raw = base64.b64decode(asset["content_base64"], validate=True).decode("utf-8")
        payload = json.loads(raw)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Stored {asset_key} asset is invalid.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Stored {asset_key} asset has invalid shape.")
    payload.setdefault("updated_at", asset.get("updated_at", ""))
    return payload


def _save_json_asset(asset_key: str, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    next_payload = {**payload, "updated_at": _now_iso()}
    encoded = base64.b64encode(json.dumps(next_payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
    _save_business_asset(asset_key, BusinessAssetUpdate(
        name=name,
        mime_type="application/json",
        content_base64=encoded,
        source_path="shared_profile",
    ))
    return next_payload


def _default_date_config() -> dict[str, Any]:
    return {
        "format": "short",
        "showYear": True,
        "flexibleSearch": True,
    }


def _normalize_date_config(value: dict[str, Any] | None) -> dict[str, Any]:
    config = _default_date_config()
    if isinstance(value, dict):
        config.update(value)
    if config.get("format") not in {"short", "numeric", "iso"}:
        config["format"] = "short"
    config["showYear"] = bool(config.get("showYear", True))
    config["flexibleSearch"] = bool(config.get("flexibleSearch", True))
    return config


def _normalize_pricing_rules(value: dict[str, Any] | None) -> dict[str, Any]:
    rules = value.get("rules") if isinstance(value, dict) else []
    sanitized_rules = []
    if isinstance(rules, list):
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                continue
            color = str(rule.get("color") or "#e8d5f5").strip()
            if not color.startswith("#") or len(color) not in (4, 7):
                color = "#e8d5f5"
            sanitized_rules.append({
                "id": str(rule.get("id") or f"rule-{index + 1}").strip(),
                "price": str(rule.get("price") or "").strip(),
                "typeValue": str(rule.get("typeValue") or "").strip(),
                "color": color,
            })
    return {
        "rules": sanitized_rules,
        "layout_version": int(value.get("layout_version") or 1) if isinstance(value, dict) else 1,
        "updated_at": value.get("updated_at", "") if isinstance(value, dict) else "",
    }


def _normalize_print_config(value: dict[str, Any] | None) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    columns = data.get("columns") if isinstance(data.get("columns"), dict) else {}
    wrap = data.get("wrap") if isinstance(data.get("wrap"), dict) else {}
    card_order = data.get("cardOrder") if isinstance(data.get("cardOrder"), list) else []
    return {
        "mode": "card" if data.get("mode") == "card" else "sheet",
        "orientation": "landscape" if data.get("orientation") == "landscape" else "portrait",
        "columns": {str(key): value is not False for key, value in columns.items()},
        "wrap": {str(key): bool(value) for key, value in wrap.items()},
        "cardOrder": [str(key).strip() for key in card_order if str(key).strip()],
        "layout_version": int(data.get("layout_version") or 1),
        "updated_at": data.get("updated_at", ""),
    }


_DOCUMENT_ASSET_KEYS = {"gift_template", "thank_you_template"}


def _asset_file_url(asset_key: str) -> str:
    if asset_key == "thank_you_template":
        return "/account/thank-you-template/file"
    return f"/account/document-assets/{asset_key}/file"


def _document_asset_metadata(asset_key: str, asset: dict[str, Any] | None) -> dict[str, Any] | None:
    if not asset or not asset.get("content_base64"):
        return None
    metadata = _asset_metadata(asset)
    metadata["asset_key"] = asset_key
    metadata["preview_url"] = _asset_file_url(asset_key)
    metadata["print_url"] = _asset_file_url(asset_key)
    return metadata


def _normalize_document_ref(value: Any, asset_key: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        asset = _load_business_asset(asset_key)
        return _document_asset_metadata(asset_key, asset)
    key = str(value.get("asset_key") or asset_key).strip()
    if key not in _DOCUMENT_ASSET_KEYS:
        key = asset_key
    asset = _load_business_asset(key)
    metadata = _document_asset_metadata(key, asset)
    if metadata:
        return metadata
    name = str(value.get("name") or "").strip()
    if not name:
        return None
    return {
        "asset_key": key,
        "name": name,
        "mime_type": str(value.get("mime_type") or "application/pdf").strip(),
        "size": int(value.get("size") or 0) if str(value.get("size") or "").isdigit() else 0,
        "updated_at": str(value.get("updated_at") or "").strip(),
        "preview_url": _asset_file_url(key),
        "print_url": _asset_file_url(key),
    }


def _clamp_number(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return min(maximum, max(minimum, number))


def _default_documents_config() -> dict[str, Any]:
    return {
        "gift_template": _document_asset_metadata("gift_template", _load_business_asset("gift_template")),
        "thank_you_template": _document_asset_metadata("thank_you_template", _load_business_asset("thank_you_template")),
        "show_gift_print_icon": True,
        "show_thank_you_shortcut": True,
        "gift_text_x": 72,
        "gift_text_y": 500,
        "gift_text_max_width": 450,
        "font_size": 12,
        "text_color": "#000000",
        "future_docs": {},
        "layout_version": 1,
        "updated_at": "",
    }


def _normalize_documents_config(value: dict[str, Any] | None) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    config = _default_documents_config()
    config.update({
        "gift_template": _normalize_document_ref(data.get("gift_template"), "gift_template") if "gift_template" in data else config["gift_template"],
        "thank_you_template": _normalize_document_ref(data.get("thank_you_template"), "thank_you_template") if "thank_you_template" in data else config["thank_you_template"],
        "show_gift_print_icon": bool(data.get("show_gift_print_icon", config["show_gift_print_icon"])),
        "show_thank_you_shortcut": bool(data.get("show_thank_you_shortcut", config["show_thank_you_shortcut"])),
        "gift_text_x": _clamp_number(data.get("gift_text_x"), config["gift_text_x"], 0, 800),
        "gift_text_y": _clamp_number(data.get("gift_text_y"), config["gift_text_y"], 0, 1200),
        "gift_text_max_width": _clamp_number(data.get("gift_text_max_width"), config["gift_text_max_width"], 50, 800),
        "font_size": _clamp_number(data.get("font_size"), config["font_size"], 6, 72),
        "text_color": _normalize_hex_color(str(data.get("text_color", config["text_color"]))),
        "future_docs": data.get("future_docs") if isinstance(data.get("future_docs"), dict) else {},
        "layout_version": int(data.get("layout_version") or 1),
        "updated_at": str(data.get("updated_at") or ""),
    })
    return config


def _validate_document_asset_key(asset_key: str) -> str:
    key = str(asset_key or "").strip()
    if key not in _DOCUMENT_ASSET_KEYS:
        raise HTTPException(status_code=404, detail="Unknown document asset.")
    return key


def _validate_pdf_asset_patch(patch: BusinessAssetUpdate) -> None:
    data = patch.model_dump(exclude_unset=True)
    if "content_base64" not in data:
        return
    content = data.get("content_base64") or ""
    if not content:
        return
    mime_type = str(data.get("mime_type") or patch.mime_type or "application/pdf").strip().lower()
    if mime_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF document templates are supported.")
    try:
        decoded = base64.b64decode(content, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid asset content encoding.") from exc
    if not decoded.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="Uploaded document must be a PDF file.")


def _validate_image_asset_patch(patch: BusinessAssetUpdate) -> None:
    data = patch.model_dump(exclude_unset=True)
    content = str(data.get("content_base64") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Logo image content is required.")
    mime_type = str(data.get("mime_type") or patch.mime_type or "").strip().lower()
    if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=400, detail="Only PNG, JPG, JPEG, or WebP logo images are supported.")
    try:
        decoded = base64.b64decode(content, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid logo content encoding.") from exc
    if len(decoded) > 2_500_000:
        raise HTTPException(status_code=400, detail="Logo image must be smaller than 2.5 MB.")
    if mime_type == "image/png" and not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=400, detail="Uploaded logo is not a valid PNG file.")
    if mime_type == "image/jpeg" and not decoded.startswith(b"\xff\xd8"):
        raise HTTPException(status_code=400, detail="Uploaded logo is not a valid JPEG file.")
    if mime_type == "image/webp" and not (decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP"):
        raise HTTPException(status_code=400, detail="Uploaded logo is not a valid WebP file.")


@router.get("/session")
def get_session(request: Request, authorization: str | None = Header(default=None)):
    user = _load_session_user(_session_id_from_request(request, authorization))
    profile = _load_profile()
    return {
        "authenticated": bool(user),
        "user": user,
        "profile": profile,
        "entitlements": _subscription_view(profile),
    }


@router.post("/auth/signup")
def signup(payload: SignupRequest, response: Response):
    email = str(payload.email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if _load_user_by_email(email):
        raise HTTPException(status_code=409, detail="An account already exists for this email.")

    now = datetime.now(timezone.utc)
    trial_ends_at = now + timedelta(days=TRIAL_DAYS)
    user_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO account_users (
                id, account_id, email, name, password_hash, role,
                created_at, updated_at, last_login_at
            ) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?)
            """,
            (
                user_id,
                ACCOUNT_ID,
                email,
                str(payload.name or "").strip(),
                _hash_password(payload.password),
                now.isoformat(),
                now.isoformat(),
                now.isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    profile_fields = {
        "account_email": email,
        "owner_name": str(payload.name or "").strip(),
        "shop_name": str(payload.shop_name or "").strip() or _load_profile().get("shop_name", ""),
        "plan_code": "spaila_one",
        "subscription_state": "trial",
        "auth_mode": "saas",
        "multi_shop_ready": False,
        "trial_started_at": now.isoformat(),
        "trial_ends_at": trial_ends_at.isoformat(),
        "billing_status": "trialing",
    }
    profile = _save_commercial_profile_fields(profile_fields)
    token = _create_session(response, user_id, ACCOUNT_ID)
    return {
        "authenticated": True,
        "session_token": token,
        "user": _load_user_public(user_id),
        "profile": profile,
        "entitlements": _subscription_view(profile),
    }


@router.post("/auth/login")
def login(payload: LoginRequest, response: Response):
    row = _load_user_by_email(payload.email)
    if not row:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    user_id, account_id, _email, _name, password_hash, _role, _created_at, _last_login_at = row
    if not _verify_password(payload.password, password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    now = _now_iso()
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE account_users SET last_login_at = ?, updated_at = ? WHERE id = ?", (now, now, user_id))
        conn.commit()
    finally:
        conn.close()
    token = _create_session(response, user_id, account_id)
    profile = _load_profile()
    return {
        "authenticated": True,
        "session_token": token,
        "user": _load_user_public(user_id),
        "profile": profile,
        "entitlements": _subscription_view(profile),
    }


@router.post("/auth/logout")
def logout(request: Request, response: Response, authorization: str | None = Header(default=None)):
    session_id = _session_id_from_request(request, authorization)
    if session_id:
        conn = get_conn()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?", (_now_iso(), session_id))
            conn.commit()
        finally:
            conn.close()
    _clear_session(response)
    return {"ok": True}


@router.post("/auth/password-reset/request")
def request_password_reset(payload: PasswordResetRequest):
    row = _load_user_by_email(payload.email)
    if not row:
        return {"ok": True, "message": "If that account exists, a reset token was created."}
    user_id, account_id = row[0], row[1]
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO password_reset_tokens (token_hash, user_id, account_id, created_at, expires_at, used_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (
                _hash_token(token),
                user_id,
                account_id,
                now.isoformat(),
                (now + timedelta(minutes=RESET_TOKEN_MINUTES)).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    # Local-first app: return token to the desktop/web shell until transactional email is added.
    return {"ok": True, "reset_token": token, "expires_in_minutes": RESET_TOKEN_MINUTES}


@router.post("/auth/password-reset/confirm")
def confirm_password_reset(payload: PasswordResetConfirm):
    token_hash = _hash_token(payload.token)
    now = _now_iso()
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT user_id, expires_at, used_at
            FROM password_reset_tokens
            WHERE token_hash = ?
            """,
            (token_hash,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="Reset token is invalid or expired.")
        user_id, expires_at, used_at = row
        if used_at or (expires_at and expires_at <= now):
            raise HTTPException(status_code=400, detail="Reset token is invalid or expired.")
        cur.execute(
            "UPDATE account_users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (_hash_password(payload.password), now, user_id),
        )
        cur.execute("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?", (now, token_hash))
        cur.execute("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (now, user_id))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/entitlements")
def get_entitlements():
    return _subscription_view(_load_profile())


@router.post("/subscription/trial/start")
def start_trial():
    profile = _load_profile()
    entitlements = _subscription_view(profile)
    if entitlements["subscription_state"] in {"trial", "active"} and not entitlements["trial_expired"]:
        return {"profile": profile, "entitlements": entitlements}
    now = datetime.now(timezone.utc)
    next_profile = _save_commercial_profile_fields({
        "plan_code": "spaila_one",
        "subscription_state": "trial",
        "auth_mode": profile.get("auth_mode") or "local_first",
        "trial_started_at": now.isoformat(),
        "trial_ends_at": (now + timedelta(days=TRIAL_DAYS)).isoformat(),
        "billing_status": "trialing",
    })
    return {"profile": next_profile, "entitlements": _subscription_view(next_profile)}


@router.patch("/subscription")
def update_subscription_for_dev(payload: DevSubscriptionUpdate):
    allowed_states = {"local_only", "trial", "active", "past_due", "canceled"}
    fields: dict[str, Any] = {}
    if payload.subscription_state:
        state = payload.subscription_state.strip().lower()
        if state not in allowed_states:
            raise HTTPException(status_code=400, detail="Unsupported subscription state.")
        fields["subscription_state"] = state
        fields["billing_status"] = "active" if state == "active" else ("trialing" if state == "trial" else state)
    if payload.plan_code:
        fields["plan_code"] = payload.plan_code.strip()
    if payload.trial_ends_at is not None:
        fields["trial_ends_at"] = payload.trial_ends_at.strip()
    profile = _save_commercial_profile_fields(fields)
    return {"profile": profile, "entitlements": _subscription_view(profile)}


@router.post("/billing/checkout")
def create_checkout_session(payload: CheckoutRequest):
    profile = _load_profile()
    price_id = os.environ.get("STRIPE_PRICE_ID", "").strip()
    if not os.environ.get("STRIPE_SECRET_KEY") or not price_id:
        return {
            "status": "configuration_required",
            "message": "Stripe secret key or price id is not configured.",
            "entitlements": _subscription_view(profile),
        }
    session = _stripe_post("checkout/sessions", {
        "mode": "subscription",
        "success_url": payload.success_url or _billing_return_url(),
        "cancel_url": payload.cancel_url or _billing_return_url(),
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": 1,
        "client_reference_id": profile.get("account_id") or ACCOUNT_ID,
        "customer": profile.get("stripe_customer_id") or None,
        "customer_email": None if profile.get("stripe_customer_id") else profile.get("account_email"),
        "subscription_data[trial_end]": _remaining_trial_end(profile),
        "subscription_data[metadata][account_id]": profile.get("account_id") or ACCOUNT_ID,
        "metadata[account_id]": profile.get("account_id") or ACCOUNT_ID,
        "metadata[source]": "spaila_mvp",
    })
    return {
        "status": "ok",
        "id": session.get("id", ""),
        "url": session.get("url", ""),
        "entitlements": _subscription_view(profile),
    }


@router.post("/billing/portal")
def create_billing_portal_session(payload: PortalRequest | None = None):
    profile = _load_profile()
    if not profile.get("stripe_customer_id"):
        return {
            "status": "configuration_required",
            "message": "No Stripe customer is linked to this account yet.",
            "entitlements": _subscription_view(profile),
        }
    portal = _stripe_post("billing_portal/sessions", {
        "customer": profile.get("stripe_customer_id"),
        "return_url": (payload.return_url if payload else None) or _billing_return_url(),
    })
    return {
        "status": "ok",
        "id": portal.get("id", ""),
        "url": portal.get("url", ""),
        "entitlements": _subscription_view(profile),
    }


@router.post("/billing/webhook")
async def stripe_webhook(request: Request, stripe_signature: str | None = Header(default=None)):
    raw = await request.body()
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    if secret:
        if not stripe_signature:
            raise HTTPException(status_code=400, detail="Missing Stripe webhook signature.")
        timestamp = ""
        signatures: list[str] = []
        for part in stripe_signature.split(","):
            key, _, value = part.partition("=")
            if key == "t":
                timestamp = value
            elif key == "v1":
                signatures.append(value)
        try:
            if not timestamp or abs(datetime.now(timezone.utc).timestamp() - int(timestamp)) > 300:
                raise ValueError("timestamp outside tolerance")
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid Stripe webhook timestamp.") from exc
        signed_payload = f"{timestamp}.{raw.decode('utf-8')}".encode("utf-8")
        expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        if not signatures or not any(hmac.compare_digest(signature, expected) for signature in signatures):
            raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature.")
    payload = json.loads(raw.decode("utf-8") or "{}")
    event_id = str(payload.get("id") or uuid.uuid4())
    event_type = str(payload.get("type") or "")
    if _billing_event_seen(event_id):
        return {"received": True, "duplicate": True, "entitlements": _subscription_view(_load_profile())}
    data_object = payload.get("data", {}).get("object", {}) if isinstance(payload.get("data"), dict) else {}
    customer_id = str(data_object.get("customer") or "")
    subscription_id = str(data_object.get("subscription") or data_object.get("id") or "")
    fields: dict[str, Any] = {}
    if event_type == "checkout.session.completed":
        fields.update({
            "plan_code": "spaila_one",
            "subscription_state": "active",
            "subscription_status": "active",
            "billing_status": "active",
            "stripe_customer_id": customer_id,
            "stripe_subscription_id": subscription_id,
        })
    elif event_type in {"customer.subscription.created", "customer.subscription.updated"}:
        fields.update(_stripe_subscription_fields(data_object))
    elif event_type == "customer.subscription.deleted":
        fields.update(_stripe_subscription_fields({**data_object, "status": "canceled"}))
        fields["canceled_at"] = fields.get("canceled_at") or _now_iso()
    elif event_type == "invoice.paid":
        fields.update({
            "plan_code": "spaila_one",
            "subscription_state": "active",
            "subscription_status": "active",
            "billing_status": "active",
            "last_payment_status": "paid",
            "stripe_customer_id": customer_id,
            "stripe_subscription_id": subscription_id,
        })
    elif event_type == "invoice.payment_failed":
        fields.update({
            "plan_code": "spaila_one",
            "subscription_state": "past_due",
            "subscription_status": "past_due",
            "billing_status": "payment_failed",
            "last_payment_status": "failed",
            "stripe_customer_id": customer_id,
            "stripe_subscription_id": subscription_id,
        })
    elif event_type == "customer.subscription.trial_will_end":
        fields.update(_stripe_subscription_fields(data_object))
    profile = _save_commercial_profile_fields(fields) if fields else _load_profile()
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT OR IGNORE INTO billing_events (
                event_id, event_type, stripe_customer_id, stripe_subscription_id, payload_json, received_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (event_id, event_type, customer_id, subscription_id, json.dumps(payload), _now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"received": True, "entitlements": _subscription_view(profile)}


@router.get("/profile")
def get_account_profile():
    profile = _load_profile()
    return {**profile, "entitlements": _subscription_view(profile)}


@router.patch("/profile")
def update_account_profile(patch: AccountProfileUpdate):
    return _save_profile(patch)


@router.get("/logo")
def get_account_logo():
    """Serve the shared shop logo, falling back to the desktop-managed local file."""
    profile = _load_profile()
    logo_path = profile.get("shop_logo_path", "").strip()
    if logo_path == "business_asset:shop_logo":
        asset = _load_business_asset("shop_logo")
        if asset and asset.get("content_base64"):
            try:
                content = base64.b64decode(asset["content_base64"], validate=True)
            except Exception as exc:
                raise HTTPException(status_code=500, detail="Stored shop logo is invalid.") from exc
            headers = {
                "Content-Disposition": f'inline; filename="{asset.get("name") or "shop-logo"}"',
                "Cache-Control": "no-store",
            }
            return Response(content=content, media_type=asset.get("mime_type") or "image/png", headers=headers)
    if not logo_path or not os.path.isfile(logo_path):
        raise HTTPException(status_code=404, detail="No logo configured or file not found.")
    return FileResponse(logo_path)


@router.patch("/logo")
def update_account_logo(patch: BusinessAssetUpdate):
    _validate_image_asset_patch(patch)
    asset = _save_business_asset("shop_logo", patch)
    profile = _save_profile(AccountProfileUpdate(shop_logo_path="business_asset:shop_logo"))
    return {**_asset_metadata(asset), "profile": profile}


@router.delete("/logo")
def delete_account_logo():
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM business_assets WHERE account_id = ? AND asset_key = ?",
            ("local-single-shop", "shop_logo"),
        )
        conn.commit()
    finally:
        conn.close()
    profile = _save_profile(AccountProfileUpdate(shop_logo_path=""))
    return {"ok": True, "profile": profile}


@router.get("/documents-config")
def get_documents_config():
    return _normalize_documents_config(_load_json_asset("documents_config"))


@router.patch("/documents-config")
def update_documents_config(patch: DocumentsConfigUpdate):
    current = _normalize_documents_config(_load_json_asset("documents_config"))
    payload = patch.model_dump(exclude_unset=True)
    for key, value in payload.items():
        current[key] = value
    return _normalize_documents_config(_save_json_asset("documents_config", "Documents settings", _normalize_documents_config(current)))


@router.get("/document-assets/{asset_key}")
def get_document_asset(asset_key: str):
    key = _validate_document_asset_key(asset_key)
    metadata = _document_asset_metadata(key, _load_business_asset(key))
    if not metadata:
        raise HTTPException(status_code=404, detail="Document asset is not configured.")
    return metadata


@router.patch("/document-assets/{asset_key}")
def update_document_asset(asset_key: str, patch: BusinessAssetUpdate):
    key = _validate_document_asset_key(asset_key)
    _validate_pdf_asset_patch(patch)
    asset = _save_business_asset(key, patch)
    metadata = _document_asset_metadata(key, asset)
    if not metadata:
        raise HTTPException(status_code=404, detail="Document asset is not configured.")
    return metadata


@router.delete("/document-assets/{asset_key}")
def delete_document_asset(asset_key: str):
    key = _validate_document_asset_key(asset_key)
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM business_assets WHERE account_id = ? AND asset_key = ?",
            ("local-single-shop", key),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "asset_key": key}


@router.get("/document-assets/{asset_key}/file")
def get_document_asset_file(asset_key: str):
    key = _validate_document_asset_key(asset_key)
    asset = _load_business_asset(key)
    if not asset or not asset.get("content_base64"):
        raise HTTPException(status_code=404, detail="Document asset is not configured.")
    try:
        content = base64.b64decode(asset["content_base64"], validate=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Stored document asset is invalid.") from exc
    headers = {
        "Content-Disposition": f'inline; filename="{asset.get("name") or key + ".pdf"}"',
        "Cache-Control": "no-store",
    }
    return Response(content=content, media_type=asset.get("mime_type") or "application/pdf", headers=headers)


@router.get("/thank-you-template")
def get_thank_you_template():
    """Return shared thank-you template metadata for web/desktop surfaces."""
    asset = _load_business_asset("thank_you_template")
    if not asset or not asset.get("content_base64"):
        raise HTTPException(status_code=404, detail="No thank-you template configured.")
    return _asset_metadata(asset)


@router.patch("/thank-you-template")
def update_thank_you_template(patch: BusinessAssetUpdate):
    """Import or update the shared thank-you template asset."""
    _validate_pdf_asset_patch(patch)
    asset = _save_business_asset("thank_you_template", patch)
    return _asset_metadata(asset)


@router.get("/thank-you-template/file")
def get_thank_you_template_file():
    """Serve the shared thank-you template bytes without exposing local paths."""
    asset = _load_business_asset("thank_you_template")
    if not asset or not asset.get("content_base64"):
        raise HTTPException(status_code=404, detail="No thank-you template configured.")
    try:
        content = base64.b64decode(asset["content_base64"], validate=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Stored thank-you template is invalid.") from exc
    headers = {
        "Content-Disposition": f'inline; filename="{asset.get("name") or "thank-you-template.pdf"}"',
        "Cache-Control": "no-store",
    }
    return Response(content=content, media_type=asset.get("mime_type") or "application/pdf", headers=headers)


@router.get("/order-field-layout")
def get_order_field_layout():
    layout = _load_json_asset("order_field_layout")
    if not layout:
        raise HTTPException(status_code=404, detail="No shared order field layout configured.")
    return layout


@router.patch("/order-field-layout")
def update_order_field_layout(patch: OrderFieldLayoutUpdate):
    payload = patch.model_dump(exclude_unset=True)
    existing = _load_json_asset("order_field_layout") or {}
    sanitized = dict(existing)

    if "fields" in payload:
        sanitized_fields = []
        for field in payload.get("fields") or []:
            if not isinstance(field, dict):
                continue
            key = str(field.get("key", "")).strip()
            if not key:
                continue
            sanitized_fields.append({
                "key": key,
                "label": str(field.get("label", "")).strip(),
                "visibleInOrders": field.get("visibleInOrders") is not False,
                "paletteEnabled": field.get("paletteEnabled") is not False,
                "highlight": field.get("highlight") if isinstance(field.get("highlight"), dict) else {},
            })
        sanitized["fields"] = sanitized_fields

    if "order" in payload:
        sanitized["order"] = [str(key).strip() for key in (payload.get("order") or []) if str(key).strip()]

    if "status" in payload:
        status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
        prev = sanitized.get("status") if isinstance(sanitized.get("status"), dict) else {}
        default_block = _default_order_status_layout()
        if "states" in status:
            next_states = _sanitize_status_states(status.get("states"))
        elif isinstance(prev, dict) and "states" in prev:
            next_states = _sanitize_status_states(prev.get("states"))
        else:
            next_states = list(default_block["states"])
        enabled = status.get("enabled") is not False if "enabled" in status else (prev.get("enabled") is not False)
        if "columnLabel" in status:
            column_label = str(status.get("columnLabel", "")).strip() or "Status"
        else:
            column_label = str(prev.get("columnLabel", "")).strip() or "Status"
        sanitized["status"] = {
            "enabled": enabled,
            "columnLabel": column_label,
            "states": next_states,
        }

    for key in ("sort_defaults", "search_defaults", "platform_overrides"):
        if key in payload and isinstance(payload.get(key), dict):
            sanitized[key] = payload[key]

    if "column_width_profiles" in payload and isinstance(payload.get("column_width_profiles"), dict):
        existing_profiles = sanitized.get("column_width_profiles") if isinstance(sanitized.get("column_width_profiles"), dict) else {}
        next_profiles = dict(existing_profiles)
        for profile_name, profile in payload["column_width_profiles"].items():
            if isinstance(profile, dict):
                next_profiles[str(profile_name)] = profile
        sanitized["column_width_profiles"] = next_profiles

    sanitized["layout_version"] = int(payload.get("layout_version") or sanitized.get("layout_version") or 1)
    return _save_json_asset("order_field_layout", "Orders field layout", sanitized)


@router.get("/date-config")
def get_date_config():
    return _normalize_date_config(_load_json_asset("date_config"))


@router.patch("/date-config")
def update_date_config(patch: DateConfigUpdate):
    payload = patch.model_dump(exclude_unset=True)
    current = _normalize_date_config(_load_json_asset("date_config"))
    for key in ("format", "showYear", "flexibleSearch"):
        if key in payload:
            current[key] = payload[key]
    return _normalize_date_config(_save_json_asset("date_config", "Date display settings", current))


@router.get("/pricing-rules")
def get_pricing_rules():
    return _normalize_pricing_rules(_load_json_asset("pricing_rules"))


@router.patch("/pricing-rules")
def update_pricing_rules(patch: PricingRulesUpdate):
    return _normalize_pricing_rules(_save_json_asset("pricing_rules", "Pricing rules", _normalize_pricing_rules(patch.model_dump())))


@router.get("/print-config")
def get_print_config():
    return _normalize_print_config(_load_json_asset("print_config"))


@router.patch("/print-config")
def update_print_config(patch: PrintConfigUpdate):
    current = _normalize_print_config(_load_json_asset("print_config"))
    payload = patch.model_dump(exclude_unset=True)
    current.update(payload)
    current["layout_version"] = int(current.get("layout_version") or 1)
    return _normalize_print_config(_save_json_asset("print_config", "Print settings", _normalize_print_config(current)))


@router.get("/web-settings")
def get_web_settings():
    return _load_web_settings()


@router.patch("/web-settings")
def update_web_settings(patch: WebSettingsUpdate):
    return _save_web_settings(patch)


@router.get("/capabilities")
def get_account_capabilities():
    entitlements = _subscription_view(_load_profile())
    return {
        "product_name": "Spaila",
        "surface": "shared_backend",
        "mvp_mode": "single_shop",
        "auth_ready": True,
        "subscription_ready": True,
        "cloud_sync_ready": False,
        "entitlements": entitlements,
        "capabilities": entitlements["capabilities"],
        **entitlements["capabilities"],
        "locked_features": entitlements["locked_features"],
        "desktop_authority": [
            "parser",
            "inbox_ingestion",
            "helper",
            "backup_restore",
            "local_filesystem",
        ],
        "web_mirror": [
            "active_orders",
            "completed_orders",
            "archive_search",
            "order_detail",
            "conversations",
            "attachments",
            "settings",
            "account",
            "billing",
            "support",
        ],
    }
