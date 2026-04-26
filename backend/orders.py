from fastapi import APIRouter, HTTPException, Request
from datetime import datetime, date, timezone
import json
import uuid
import os
import re
import shutil
from pathlib import Path
from .db import get_conn
from workspace_paths import ensure_workspace_layout

_WORKSPACE_DIRS = ensure_workspace_layout(print)
BASE_PATH = _WORKSPACE_DIRS["root"]
INBOX_PATH = _WORKSPACE_DIRS["Inbox"]
ORDERS_PATH = _WORKSPACE_DIRS["Orders"]
ORDER_ARCHIVE_SETTINGS_FILENAME = "order_archive_settings.json"


# ── Folder creation (mirrors helper/sync_folders.py logic) ───────────────────

def _sanitize_for_fs(text: str) -> str:
    text = str(text).strip()
    text = re.sub(r'[<>:"/\\|?*]', "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _format_folder_name(buyer_name: str | None, order_number: str) -> str:
    oid = _sanitize_for_fs(order_number) or "unknown"
    if not buyer_name:
        return f"Unknown – {oid}"
    name = _sanitize_for_fs(buyer_name.strip())
    lower = name.lower()
    if any(x in lower for x in ["family", "llc", "inc", "corp", "company"]):
        return f"{name} – {oid}"
    parts = name.split()
    if len(parts) < 2:
        return f"{name} – {oid}"
    first, last = parts[0], parts[-1]
    middle = " ".join(parts[1:-1])
    formatted = f"{last}, {first} {middle}".strip() if middle else f"{last}, {first}"
    return f"{formatted} – {oid}"


def _make_order_folder(
    buyer_name: str | None,
    order_number: str,
    order_date: str | None,
) -> str | None:
    """Create ~/Spaila/orders/YYYY/month/<name> and return the path."""
    try:
        dt: date | None = None
        if order_date:
            s = str(order_date).strip()
            if len(s) >= 10 and s[4] == "-":
                dt = datetime.fromisoformat(s[:10]).date()
        if dt is None:
            dt = datetime.now().date()

        year  = str(dt.year)
        month = dt.strftime("%B").lower()
        folder_name = _format_folder_name(buyer_name, order_number)
        path = ORDERS_PATH / year / month / folder_name
        path.mkdir(parents=True, exist_ok=True)
        return str(path)
    except Exception as e:
        print(f"[CREATE] folder creation failed: {e}")
        return None

router = APIRouter()


def _as_bool_int(value) -> int:
    if isinstance(value, str):
        return 1 if value.strip().lower() in {"1", "true", "yes", "on"} else 0
    return 1 if bool(value) else 0


def _parse_order_messages(value) -> list[dict]:
    try:
        parsed = json.loads(value or "[]")
    except Exception:
        return []
    return parsed if isinstance(parsed, list) else []


def _norm_msg_id(value: object) -> str:
    return str(value or "").strip().replace("<", "").replace(">", "").lower()


def _norm_body(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso_dt(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _resolve_archive_root(body: dict | None) -> Path:
    """Filesystem root for archived order folders (e.g. C:/Spaila/archive/)."""
    body = body or {}
    br = str(body.get("archive_root") or "").strip()
    if br:
        p = Path(br).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p.resolve()
    fp = BASE_PATH / ORDER_ARCHIVE_SETTINGS_FILENAME
    if fp.is_file():
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            dr = str(data.get("archive_root") or "").strip()
            if dr:
                p = Path(dr).expanduser()
                p.mkdir(parents=True, exist_ok=True)
                return p.resolve()
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    default = (BASE_PATH / "archive").resolve()
    default.mkdir(parents=True, exist_ok=True)
    return default


def _path_under_base(child: Path, base: Path) -> bool:
    try:
        child.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _first_unique_archive_destination(desired: Path) -> Path:
    if not desired.exists():
        return desired
    parent = desired.parent
    stem = desired.name
    print(
        f"[ORDER_FOLDER_ARCHIVE_CONFLICT] desired_path={desired} "
        "message=target_exists_using_suffix"
    )
    for i in range(1, 10000):
        cand = parent / f"{stem}__conflict{i}"
        if not cand.exists():
            return cand
    raise OSError("could not allocate unique archive folder name")


def _move_order_folder_for_archive(
    order_id: str,
    old_path_str: str | None,
    archive_root: Path,
) -> str | None:
    """
    Move the order directory from the Orders tree into archive_root, preserving
    the path relative to Orders (e.g. .../Orders/2026/april/Name – 123 → archive_root/2026/april/Name – 123).

    Returns the new absolute path to store on the order row, or None to leave order_folder_path unchanged.
    """
    raw = str(old_path_str or "").strip()
    if not raw:
        print(f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=no_folder_path")
        return None

    try:
        src = Path(raw).expanduser().resolve()
    except OSError as exc:
        print(f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=bad_path error={exc}")
        return None

    ar = archive_root.resolve()
    ob = ORDERS_PATH.resolve()

    if _path_under_base(src, ar):
        return str(src)

    if not _path_under_base(src, ob):
        print(
            f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=outside_orders path={src}"
        )
        return None

    if not src.exists():
        print(f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=source_missing path={src}")
        return None
    if not src.is_dir():
        print(f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=not_a_directory path={src}")
        return None

    try:
        rel = src.relative_to(ob)
    except ValueError:
        print(f"[ORDER_FOLDER_ARCHIVE_SKIP] order_id={order_id} reason=relative_to_failed path={src}")
        return None

    desired = ar / rel
    desired.parent.mkdir(parents=True, exist_ok=True)
    target = _first_unique_archive_destination(desired)

    try:
        shutil.move(str(src), str(target))
    except OSError as exc:
        print(f"[ORDER_FOLDER_ARCHIVE_FAIL] order_id={order_id} error={exc}")
        return None

    final_path = str(target.resolve())
    print(f"[ORDER_FOLDER_MOVED] order_id={order_id} from_path={src} to_path={final_path}")
    return final_path


def _archive_reference_dt(last_activity_at, updated_at, created_at) -> tuple[datetime, str, str]:
    """Return (parsed_datetime, field_name_used, raw_string_used_for_log)."""
    for label, s in (
        ("last_activity_at", last_activity_at),
        ("updated_at", updated_at),
        ("created_at", created_at),
    ):
        dt = _parse_iso_dt(s)
        if dt:
            return dt, label, str(s).strip()
    fallback = _parse_iso_dt(created_at) or datetime.now(timezone.utc)
    return fallback, "created_at", str(created_at or "").strip()


def _manual_assign_duplicate_reason(messages: list, new_msg: dict) -> str:
    ne = str(new_msg.get("email_id") or "").strip().lower()
    nm = _norm_msg_id(new_msg.get("message_id") or new_msg.get("id") or "")
    nb = _norm_body(new_msg.get("body") or "")
    ns = str(new_msg.get("sender") or "").strip().lower()
    nt = str(new_msg.get("timestamp") or "").strip()

    for existing in messages:
        if not isinstance(existing, dict):
            continue
        direction = str(existing.get("type") or existing.get("direction") or "").lower()
        if direction != "inbound":
            continue
        ee = str(existing.get("email_id") or "").strip().lower()
        if ne and ee and ne == ee:
            return "email_id"
        em = _norm_msg_id(existing.get("message_id") or existing.get("id") or "")
        if nm and em and nm == em:
            return "message_id"
        if not nb:
            continue
        eb = _norm_body(existing.get("body") or "")
        es = str(existing.get("sender") or existing.get("from") or "").strip().lower()
        if eb != nb or not ns or es != ns:
            continue
        et = str(existing.get("timestamp") or "").strip()
        try:
            ta = datetime.fromisoformat(nt.replace("Z", "+00:00"))
            tb = datetime.fromisoformat(et.replace("Z", "+00:00"))
            if ta.tzinfo is None:
                ta = ta.replace(tzinfo=timezone.utc)
            if tb.tzinfo is None:
                tb = tb.replace(tzinfo=timezone.utc)
            if abs((ta - tb).total_seconds()) <= 10:
                return "body_sender_time"
        except Exception:
            if nt == et:
                return "body_sender_time"
    return ""


@router.post("/orders/create")
async def create_order(payload: dict):
    order = payload.get("order", {})
    items = payload.get("items", [])

    order_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()
    activity_ts = created_at
    source_eml_path = payload.get("meta", {}).get("source_eml_path")

    order_number = order.get("order_number") or ""
    buyer_name   = order.get("buyer_name")
    order_date   = order.get("order_date")
    ship_by      = str(order.get("ship_by") or "").strip()
    if not ship_by:
        raise HTTPException(status_code=400, detail="Ship by date is required.")

    # Create the folder immediately so Show Folder works without waiting for the helper
    order_folder_path = _make_order_folder(buyer_name, order_number, order_date)

    conn = get_conn()
    cur = conn.cursor()

    platform = (payload.get("meta", {}).get("platform") or "unknown").lower()

    cur.execute("""
        INSERT INTO orders (
            id, order_number, order_date, buyer_name,
            buyer_email, shipping_address, ship_by,
            status, created_at, last_activity_at, updated_at,
            source_eml_path, eml_path, order_folder_path,
            platform, is_gift, gift_wrap
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        order_id,
        order_number,
        order_date,
        buyer_name,
        order.get("buyer_email"),
        order.get("shipping_address"),
        ship_by,
        "active",
        created_at,
        activity_ts,
        activity_ts,
        source_eml_path,
        None,               # eml_path — helper moves the file here
        order_folder_path,  # set immediately at creation
        platform,
        _as_bool_int(order.get("is_gift")),
        _as_bool_int(order.get("gift_wrap")),
    ))

    # gift_message is order-level from the parser payload but stored per-item
    # so each item gets the same initial value (they can diverge after editing).
    order_gift_message = order.get("gift_message") or None

    for item in items:
        cur.execute("""
            INSERT INTO items (
                id, order_id, item_index, quantity, price,
                custom_1, custom_2, custom_3,
                custom_4, custom_5, custom_6,
                order_notes, gift_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            str(uuid.uuid4()),
            order_id,
            item.get("item_index"),
            item.get("quantity"),
            item.get("price"),
            item["custom_fields"].get("custom_1"),
            item["custom_fields"].get("custom_2"),
            item["custom_fields"].get("custom_3"),
            item["custom_fields"].get("custom_4"),
            item["custom_fields"].get("custom_5"),
            item["custom_fields"].get("custom_6"),
            item.get("order_notes") or None,
            item.get("gift_message") or order_gift_message,
        ))

    conn.commit()
    conn.close()

    print(f"SAVED TO DB: {order_id} {order_number} -> {order_folder_path}")

    return {
        "id": order_id,
        "status": "created",
        "created_at": created_at,
        "order_folder_path": order_folder_path,
    }


@router.post("/orders/create-manual")
def create_manual_order(payload: dict):
    order_number = str(payload.get("order_number") or "").strip()
    if not order_number:
        raise HTTPException(status_code=400, detail="Order number is required.")

    order_id = str(uuid.uuid4())
    item_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()
    activity_ts = created_at
    buyer_name = payload.get("buyer_name") or ""
    order_date = payload.get("order_date")
    status = payload.get("status") or "active"
    order_folder_path = _make_order_folder(buyer_name, order_number, order_date)

    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO orders (
            id, order_number, order_date, buyer_name,
            buyer_email, shipping_address, ship_by,
            status, created_at, last_activity_at, updated_at,
            source_eml_path, eml_path, order_folder_path,
            platform, is_gift, gift_wrap
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        order_id,
        order_number,
        order_date,
        buyer_name,
        payload.get("buyer_email") or None,
        payload.get("shipping_address") or None,
        payload.get("ship_by") or None,
        status,
        created_at,
        activity_ts,
        activity_ts,
        None,
        None,
        order_folder_path,
        "unknown",
        _as_bool_int(payload.get("is_gift")),
        _as_bool_int(payload.get("gift_wrap")),
    ))

    cur.execute("""
        INSERT INTO items (
            id, order_id, item_index, quantity, price,
            custom_1, custom_2, custom_3,
            custom_4, custom_5, custom_6,
            order_notes, gift_message, item_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        item_id,
        order_id,
        0,
        payload.get("quantity") or None,
        payload.get("price") or None,
        payload.get("custom_1") or None,
        payload.get("custom_2") or None,
        payload.get("custom_3") or None,
        payload.get("custom_4") or None,
        payload.get("custom_5") or None,
        payload.get("custom_6") or None,
        payload.get("order_notes") or None,
        payload.get("gift_message") or None,
        None,
    ))

    conn.commit()
    conn.close()

    return {
        "status": "created",
        "id": item_id,
        "order_id": order_id,
        "created_at": created_at,
        "order_folder_path": order_folder_path,
    }


@router.get("/orders")
def get_orders():
    """Orders-only data for helper (folder creation, EML matching, PATCH-back). No JOIN."""
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            id,
            order_number,
            order_date,
            buyer_name,
            order_folder_path,
            source_eml_path,
            eml_path
        FROM orders
    """)

    rows = cur.fetchall()
    conn.close()

    return [
        {
            "id": r[0],
            "order_number": r[1],
            "order_date": r[2],
            "buyer_name": r[3],
            "order_folder_path": r[4],
            "source_eml_path": r[5],
            "eml_path": r[6],
        }
        for r in rows
    ]


@router.get("/orders/list")
def list_orders():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            items.id,
            orders.id,
            orders.order_number,
            orders.buyer_name,
            orders.buyer_email,
            orders.shipping_address,
            orders.order_date,
            orders.ship_by,
            orders.status,
            items.price,
            items.quantity,
            items.custom_1,
            items.custom_2,
            items.custom_3,
            items.custom_4,
            items.custom_5,
            items.custom_6,
            orders.order_folder_path,
            orders.source_eml_path,
            orders.eml_path,
            items.gift_message,
            items.order_notes,
            items.item_index,
            orders.platform,
            items.item_status,
            orders.is_gift,
            orders.gift_wrap,
            orders.messages
        FROM items
        JOIN orders ON items.order_id = orders.id
        WHERE orders.status NOT IN ('deleted')
        ORDER BY orders.created_at DESC, items.item_index ASC
    """)

    rows = cur.fetchall()
    conn.close()

    return [
        {
            "id": r[0],
            "order_id": r[1],
            "order_number": r[2],
            "buyer_name": r[3],
            "buyer_email": r[4],
            "shipping_address": r[5],
            "order_date": r[6],
            "ship_by": r[7],
            "status": r[8],
            "price": r[9],
            "quantity": r[10],
            "custom_1": r[11],
            "custom_2": r[12],
            "custom_3": r[13],
            "custom_4": r[14],
            "custom_5": r[15],
            "custom_6": r[16],
            "order_folder_path": r[17],
            "source_eml_path": r[18],
            "eml_path": r[19],
            "gift_message": r[20],
            "order_notes": r[21],
            "item_index": r[22],
            "platform":    r[23] or "unknown",
            "item_status": r[24] or None,
            "is_gift": bool(r[25]),
            "gift_wrap": bool(r[26]),
            "messages": _parse_order_messages(r[27]),
        }
        for r in rows
    ]


@router.get("/orders/{order_id}")
def get_order(order_id: str):
    """Single order row including messages (for modal thread sync without full list)."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            id,
            order_number,
            buyer_name,
            buyer_email,
            shipping_address,
            order_date,
            ship_by,
            status,
            order_folder_path,
            messages
        FROM orders
        WHERE id = ? AND status NOT IN ('deleted')
        """,
        (order_id,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found.")
    return {
        "order_id": row[0],
        "id": row[0],
        "order_number": row[1],
        "buyer_name": row[2],
        "buyer_email": row[3],
        "shipping_address": row[4],
        "order_date": row[5],
        "ship_by": row[6],
        "status": row[7],
        "order_folder_path": row[8],
        "messages": _parse_order_messages(row[9]),
    }


@router.post("/orders/update-full")
def update_full(payload: dict):
    conn = get_conn()
    cur = conn.cursor()
    touch_ts = datetime.utcnow().isoformat()
    order_id = payload.get("order_id")
    new_status = str(payload.get("status") or "active").lower()

    moved_folder_path: str | None = None
    if order_id:
        cur.execute(
            "SELECT status, order_folder_path FROM orders WHERE id = ? AND status NOT IN ('deleted')",
            (order_id,),
        )
        prev_row = cur.fetchone()
        if prev_row:
            prev_status = str(prev_row[0] or "").lower()
            if new_status == "archived" and prev_status != "archived":
                ar = _resolve_archive_root({"archive_root": payload.get("archive_root")})
                moved_folder_path = _move_order_folder_for_archive(order_id, prev_row[1], ar)

    order_parts: list[tuple[str, object]] = [
        ("order_number", payload.get("order_number")),
        ("buyer_name", payload.get("buyer_name") or None),
        ("buyer_email", payload.get("buyer_email") or None),
        ("shipping_address", payload.get("shipping_address") or None),
        ("order_date", payload.get("order_date")),
        ("ship_by", payload.get("ship_by")),
        ("is_gift", _as_bool_int(payload.get("is_gift"))),
        ("gift_wrap", _as_bool_int(payload.get("gift_wrap"))),
        ("status", payload.get("status", "active")),
    ]
    if moved_folder_path is not None:
        order_parts.append(("order_folder_path", moved_folder_path))
    order_parts.append(("last_activity_at", touch_ts))
    order_parts.append(("updated_at", touch_ts))

    set_clause = ", ".join(f"{name} = ?" for name, _ in order_parts)
    order_values = [value for _, value in order_parts] + [order_id]
    cur.execute(f"UPDATE orders SET {set_clause} WHERE id = ?", order_values)

    # Item-level fields — isolated to the specific item being edited
    cur.execute("""
        UPDATE items SET
            quantity     = ?,
            price        = ?,
            custom_1     = ?,
            custom_2     = ?,
            custom_3     = ?,
            custom_4     = ?,
            custom_5     = ?,
            custom_6     = ?,
            order_notes  = ?,
            gift_message = ?
        WHERE id = ?
    """, (
        payload.get("quantity"),
        payload.get("price"),
        payload.get("custom_1"),
        payload.get("custom_2"),
        payload.get("custom_3"),
        payload.get("custom_4"),
        payload.get("custom_5"),
        payload.get("custom_6"),
        payload.get("order_notes") or None,
        payload.get("gift_message") or None,
        payload.get("id"),
    ))

    conn.commit()
    conn.close()

    return {"status": "ok"}


@router.post("/orders/{order_id}/messages/manual-assign")
def manual_assign_inbox_to_order(order_id: str, payload: dict):
    """
    Append an inbox email as an inbound thread message (manual fix for unmatched mail).
    Dedupes against existing messages before append.
    """
    email_id = str(payload.get("email_id") or "").strip()
    subject = str(payload.get("subject") or "").strip()
    body = str(payload.get("body") or "").strip()
    sender = str(payload.get("sender") or "").strip()
    timestamp = str(payload.get("timestamp") or "").strip()
    message_id_raw = str(payload.get("message_id") or "").strip()

    if not body and not subject:
        raise HTTPException(status_code=400, detail="subject or body is required.")
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat()

    row_id = (message_id_raw.strip() if message_id_raw else "") or (f"manual:{email_id}" if email_id else str(uuid.uuid4()))
    next_message = {
        "id": row_id,
        "type": "inbound",
        "direction": "inbound",
        "body": body,
        "subject": subject,
        "sender": sender,
        "timestamp": timestamp,
        "source": "manual_assign",
        "email_id": email_id,
    }
    if message_id_raw:
        next_message["message_id"] = message_id_raw

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT messages FROM orders WHERE id = ? AND status NOT IN ('deleted')", (order_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Order not found.")

    messages = _parse_order_messages(row[0])
    reason = _manual_assign_duplicate_reason(messages, next_message)
    if reason:
        conn.close()
        return {"status": "duplicate", "reason": reason, "message": None}

    messages.append(next_message)
    touch_ts = datetime.utcnow().isoformat()
    cur.execute(
        "UPDATE orders SET messages = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
        (json.dumps(messages), touch_ts, touch_ts, order_id),
    )
    conn.commit()
    conn.close()
    return {"status": "ok", "message": next_message}


@router.post("/orders/{order_id}/messages")
def append_order_message(order_id: str, payload: dict):
    message = payload.get("message") if isinstance(payload.get("message"), dict) else payload
    body = str(message.get("body") or "")
    attachments = message.get("attachments") if isinstance(message.get("attachments"), list) else []
    if not body.strip() and not attachments:
        raise HTTPException(status_code=400, detail="Message body or attachment is required.")

    next_message = {
        "type": str(message.get("type") or message.get("direction") or "outbound"),
        "direction": str(message.get("direction") or message.get("type") or "outbound"),
        "body": body,
        "timestamp": str(message.get("timestamp") or datetime.utcnow().isoformat()),
    }
    for optional_key in (
        "subject",
        "to",
        "from",
        "attachments",
        "id",
        "status",
        "message_id",
        "email_id",
        "direction",
        "type",
    ):
        if optional_key in message:
            next_message[optional_key] = message.get(optional_key)

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT messages FROM orders WHERE id = ?", (order_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Order not found.")

    messages = _parse_order_messages(row[0])
    messages.append(next_message)
    touch_ts = datetime.utcnow().isoformat()
    cur.execute(
        "UPDATE orders SET messages = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
        (json.dumps(messages), touch_ts, touch_ts, order_id),
    )
    conn.commit()
    conn.close()
    return {"status": "ok", "message": next_message}


@router.post("/orders/auto-archive/run")
async def run_auto_archive(request: Request):
    """Set status='archived' for eligible orders; moves order folder into archive_root; never modifies messages."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    days_raw = body.get("days")
    try:
        days_n = int(days_raw) if days_raw is not None else 0
    except Exception:
        days_n = 0
    if days_n <= 0:
        return {"status": "skipped", "reason": "invalid_or_disabled_days", "archived": [], "archived_count": 0}

    archive_root = _resolve_archive_root(body)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, created_at, last_activity_at, updated_at, status, order_folder_path
        FROM orders
        WHERE status NOT IN ('deleted', 'archived')
        """
    )
    rows = cur.fetchall()
    now = datetime.now(timezone.utc)
    archived: list[str] = []
    touch = _now_iso_utc()

    for row in rows:
        oid, created_at, last_activity_at, updated_at, _status, folder_path = row
        ref_dt, _ref_field, ref_raw = _archive_reference_dt(last_activity_at, updated_at, created_at)
        elapsed_days = (now - ref_dt).total_seconds() / 86400.0
        if elapsed_days <= float(days_n):
            continue
        new_fp = _move_order_folder_for_archive(oid, folder_path, archive_root)
        if new_fp is not None:
            cur.execute(
                "UPDATE orders SET status = 'archived', updated_at = ?, order_folder_path = ? WHERE id = ?",
                (touch, new_fp, oid),
            )
        else:
            cur.execute(
                "UPDATE orders SET status = 'archived', updated_at = ? WHERE id = ?",
                (touch, oid),
            )
        print(
            f"[ORDER_AUTO_ARCHIVED] order_id={oid} reference_date={ref_raw} days_elapsed={elapsed_days:.4f}"
        )
        archived.append(oid)

    conn.commit()
    conn.close()
    return {"status": "ok", "archived": archived, "archived_count": len(archived)}


@router.post("/orders/requeue-all")
def requeue_all():
    return {
        "queued": [],
        "skipped_missing": [],
        "message": "Deprecated. Helper owns inbox and file movement.",
    }


@router.delete("/orders/{order_id}")
def delete_order(order_id: str):
    """
    Mark order as deleted. Removes the physical folder only when:
      - this is the last order row sharing the same order_number
      - the folder path is inside the allowed base directory
      - the folder actually exists on disk
    """
    conn = get_conn()
    cur = conn.cursor()

    # Fetch the order we are deleting
    cur.execute(
        "SELECT order_number, order_folder_path FROM orders WHERE id = ?",
        (order_id,),
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        return {"success": False, "error": "Order not found"}

    order_number, order_folder_path = row

    # Count other active orders that share this order_number
    cur.execute(
        "SELECT COUNT(*) FROM orders WHERE order_number = ? AND id != ? AND status != 'deleted'",
        (order_number, order_id),
    )
    sibling_count = cur.fetchone()[0]

    # Mark this order (and its items) as deleted
    cur.execute("UPDATE orders SET status = 'deleted' WHERE id = ?", (order_id,))
    cur.execute(
        "UPDATE items SET quantity = items.quantity WHERE order_id = ?", (order_id,)
    )  # no-op to avoid a separate items delete for now; status on order is enough
    conn.commit()
    conn.close()

    folder_deleted = False

    if sibling_count == 0 and order_folder_path:
        folder_deleted = _try_delete_folder(order_folder_path)

    print(
        f"[DELETE] order={order_number} id={order_id} "
        f"siblings={sibling_count} folder_deleted={folder_deleted}"
    )
    return {"success": True, "folder_deleted": folder_deleted}


def _try_delete_folder(folder_path: str) -> bool:
    """Delete folder only if it is under Orders or the configured order archive root."""
    try:
        path = Path(folder_path).resolve()
        if not (_path_under_base(path, ORDERS_PATH.resolve()) or _path_under_base(path, _resolve_archive_root({}))):
            print(f"[DELETE] refused — outside allowed paths: {path}")
            return False

        if not path.exists():
            return False

        shutil.rmtree(path)
        print(f"[DELETE] removed folder: {path}")
        return True
    except Exception as e:
        print(f"[DELETE] folder removal failed: {e}")
        return False


@router.patch("/orders/{order_id}")
def patch_order(order_id: str, payload: dict):
    """Partial update used by the helper to write back paths after folder creation / EML move."""
    PATCHABLE = {
        "order_folder_path",
        "source_eml_path",
        "eml_path",
        "source_original_path",
        "status",
    }

    fields = {k: v for k, v in payload.items() if k in PATCHABLE}
    conn = get_conn()
    cur = conn.cursor()

    if fields.get("status") is not None and str(fields.get("status")).lower() == "archived":
        cur.execute("SELECT status, order_folder_path FROM orders WHERE id = ?", (order_id,))
        prev = cur.fetchone()
        if prev and str(prev[0] or "").lower() != "archived":
            ar = _resolve_archive_root({})
            new_fp = _move_order_folder_for_archive(order_id, prev[1], ar)
            if new_fp is not None:
                fields["order_folder_path"] = new_fp

    if not fields:
        conn.close()
        return {"status": "ok", "updated": 0}

    fields["updated_at"] = _now_iso_utc()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [order_id]

    cur.execute(
        f"UPDATE orders SET {set_clause} WHERE id = ?",
        values,
    )
    updated = cur.rowcount
    conn.commit()
    conn.close()

    return {"status": "ok", "updated": updated}


@router.patch("/items/{item_id}/status")
def patch_item_status(item_id: str, payload: dict):
    """Set item_status for a single item row (independent of order-level status)."""
    status = payload.get("item_status")
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE items SET item_status = ? WHERE id = ?", (status, item_id))
    conn.commit()
    conn.close()
    return {"status": "ok"}
