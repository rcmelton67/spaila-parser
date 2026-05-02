import base64
import json
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ...db import get_conn


router = APIRouter(prefix="/account", tags=["account"])


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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
                   auth_mode, multi_shop_ready, created_at, updated_at
            FROM account_profiles
            WHERE account_id = ?
            """,
            ("local-single-shop",),
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
                auth_mode, multi_shop_ready, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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


@router.get("/profile")
def get_account_profile():
    return _load_profile()


@router.patch("/profile")
def update_account_profile(patch: AccountProfileUpdate):
    return _save_profile(patch)


@router.get("/logo")
def get_account_logo():
    """Serve the shop logo file set via the desktop app."""
    profile = _load_profile()
    logo_path = profile.get("shop_logo_path", "").strip()
    if not logo_path or not os.path.isfile(logo_path):
        raise HTTPException(status_code=404, detail="No logo configured or file not found.")
    return FileResponse(logo_path)


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
        sanitized["status"] = {
            "enabled": status.get("enabled") is not False,
            "columnLabel": str(status.get("columnLabel", "")).strip() or "Status",
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


@router.get("/web-settings")
def get_web_settings():
    return _load_web_settings()


@router.patch("/web-settings")
def update_web_settings(patch: WebSettingsUpdate):
    return _save_web_settings(patch)


@router.get("/capabilities")
def get_account_capabilities():
    return {
        "product_name": "Spaila",
        "surface": "shared_backend",
        "mvp_mode": "single_shop",
        "auth_ready": True,
        "subscription_ready": True,
        "cloud_sync_ready": False,
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
