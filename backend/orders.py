from fastapi import APIRouter, HTTPException
from datetime import datetime, date
import uuid
import os
import re
from pathlib import Path
from .db import get_conn
from workspace_paths import ensure_workspace_layout

_WORKSPACE_DIRS = ensure_workspace_layout(print)
BASE_PATH = _WORKSPACE_DIRS["root"]
INBOX_PATH = _WORKSPACE_DIRS["Inbox"]
ORDERS_PATH = _WORKSPACE_DIRS["Orders"]


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


@router.post("/orders/create")
async def create_order(payload: dict):
    order = payload.get("order", {})
    items = payload.get("items", [])

    order_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()
    source_eml_path = payload.get("meta", {}).get("source_eml_path")

    order_number = order.get("order_number") or ""
    buyer_name   = order.get("buyer_name")
    order_date   = order.get("order_date")

    # Create the folder immediately so Show Folder works without waiting for the helper
    order_folder_path = _make_order_folder(buyer_name, order_number, order_date)

    conn = get_conn()
    cur = conn.cursor()

    platform = (payload.get("meta", {}).get("platform") or "unknown").lower()

    cur.execute("""
        INSERT INTO orders (
            id, order_number, order_date, buyer_name,
            buyer_email, shipping_address, ship_by,
            status, created_at,
            source_eml_path, eml_path, order_folder_path,
            platform
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        order_id,
        order_number,
        order_date,
        buyer_name,
        order.get("buyer_email"),
        order.get("shipping_address"),
        order.get("ship_by"),
        "active",
        created_at,
        source_eml_path,
        None,               # eml_path — helper moves the file here
        order_folder_path,  # set immediately at creation
        platform,
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
            status, created_at,
            source_eml_path, eml_path, order_folder_path,
            platform
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        None,
        None,
        order_folder_path,
        "unknown",
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
            items.item_status
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
        }
        for r in rows
    ]


@router.post("/orders/update-full")
def update_full(payload: dict):
    conn = get_conn()
    cur = conn.cursor()

    # Order-level fields — shared across all items of this order
    cur.execute("""
        UPDATE orders SET
            order_number      = ?,
            buyer_name        = ?,
            buyer_email       = ?,
            shipping_address  = ?,
            order_date        = ?,
            ship_by           = ?,
            status            = ?
        WHERE id = ?
    """, (
        payload.get("order_number"),
        payload.get("buyer_name") or None,
        payload.get("buyer_email") or None,
        payload.get("shipping_address") or None,
        payload.get("order_date"),
        payload.get("ship_by"),
        payload.get("status", "active"),
        payload.get("order_id"),
    ))

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
    """Delete folder only if it is inside the allowed base path and exists on disk."""
    try:
        path = Path(folder_path).resolve()
        base = ORDERS_PATH.resolve()

        # Safety guard: must be a child of the orders base directory
        if not str(path).startswith(str(base)):
            print(f"[DELETE] refused — outside base path: {path}")
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
    if not fields:
        return {"status": "ok", "updated": 0}

    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [order_id]

    conn = get_conn()
    cur = conn.cursor()
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
