from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from datetime import datetime, date, timezone, timedelta
import json
import uuid
import os
import re
import shutil
from pathlib import Path
import mimetypes
from .db import get_conn
from .date_search import build_date_search_aliases, expand_search_value_aliases, normalized_search_matches
from .api.routes.account import _require_feature
from workspace_paths import ensure_workspace_layout

_WORKSPACE_DIRS = ensure_workspace_layout(print)
BASE_PATH = _WORKSPACE_DIRS["root"]
INBOX_PATH = _WORKSPACE_DIRS["Inbox"]
ORDERS_PATH = _WORKSPACE_DIRS["Orders"]
ORDER_ARCHIVE_SETTINGS_FILENAME = "order_archive_settings.json"
PROCESSED_REFS_FILENAME = ".processedInboxRefs.json"
MAX_PROCESSED_REFS = 5000


# ── Processed inbox ref helpers (mirror the frontend getProcessedEmailRefVariants logic) ─

def _normalize_ref(value: str | None) -> str:
    """Lowercase, strip, normalise path separators."""
    return str(value or "").strip().lower().replace("\\", "/")


def _processed_ref_variants(value: str | None) -> list[str]:
    """Return [full_normalised_path, filename] variants (same as frontend getProcessedEmailRefVariants)."""
    ref = _normalize_ref(value)
    if not ref:
        return []
    parts = [p for p in ref.split("/") if p]
    filename = parts[-1] if parts else ""
    return [ref, filename] if (filename and filename != ref) else [ref]


def _extract_eml_uid(file_path: str | None) -> str:
    """Extract the bare IMAP UID from a {timestamp}_{uid}.eml filename (mirrors frontend extractEmlUid)."""
    name = _normalize_ref(file_path).split("/")[-1] if file_path else ""
    m = re.match(r"^\d+_([a-z0-9]+)\.eml$", name, re.IGNORECASE)
    return m.group(1).lower() if m else ""


def _persist_processed_refs(new_refs: list[str]) -> None:
    """
    Merge new_refs into BASE_PATH/.processedInboxRefs.json so the frontend can
    load them on startup and keep inbox filtering working after orders are removed
    from the database.
    """
    fp = BASE_PATH / PROCESSED_REFS_FILENAME
    try:
        existing: list[str] = []
        if fp.is_file():
            data = json.loads(fp.read_text(encoding="utf-8"))
            if isinstance(data, list):
                existing = data
    except (OSError, json.JSONDecodeError):
        existing = []
    seen: dict[str, None] = dict.fromkeys(existing)
    for ref in new_refs:
        if ref:
            seen[ref] = None
    merged = list(seen.keys())[-MAX_PROCESSED_REFS:]
    try:
        fp.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        print(f"[PROCESSED_REFS_WRITE_FAIL] error={exc}")


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


def _conflict_if_stale(cur, order_id: str, base_updated_at: str | None) -> None:
    token = str(base_updated_at or "").strip()
    if not token:
        return
    cur.execute("SELECT updated_at, order_number, buyer_name FROM orders WHERE id = ?", (order_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found.")
    current_updated_at = str(row[0] or "").strip()
    if current_updated_at and current_updated_at != token:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Order changed since it was opened.",
                "current_updated_at": current_updated_at,
                "order_id": order_id,
                "order_number": row[1],
                "buyer_name": row[2],
            },
        )


def _next_order_touch_ts(cur, order_id: str) -> str:
    now = datetime.utcnow()
    cur.execute("SELECT updated_at FROM orders WHERE id = ?", (order_id,))
    row = cur.fetchone()
    current = str(row[0] or "").strip() if row else ""
    try:
        current_dt = datetime.fromisoformat(current)
        if now <= current_dt:
            now = current_dt + timedelta(microseconds=1)
    except Exception:
        pass
    return now.isoformat()


def _norm_msg_id(value: object) -> str:
    return str(value or "").strip().replace("<", "").replace(">", "").lower()


def _norm_body(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


def _looks_absolute_path(value: object) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    if raw.startswith("/") or raw.startswith("\\\\"):
        return True
    return bool(re.match(r"^[A-Za-z]:[\\/]", raw))


def _normalize_attachment_entry(value: object):
    """
    Convert attachment references to archive-safe values.
    - Absolute paths become: {"file": "<basename>", "original_path": "<absolute path>"}.
    - Relative strings become: "<relative or filename>".
    - Dict attachments preserve existing metadata while normalising file/path.
    """
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        normalized = raw.replace("\\", "/")
        file_name = normalized.split("/")[-1] or normalized
        if _looks_absolute_path(raw):
            return {"file": file_name, "original_path": raw}
        rel = normalized[2:] if normalized.startswith("./") else normalized
        return rel or file_name

    if isinstance(value, dict):
        out = dict(value)
        raw = str(
            out.get("path")
            or out.get("file")
            or out.get("original_path")
            or out.get("name")
            or ""
        ).strip()
        if not raw:
            return out
        normalized = raw.replace("\\", "/")
        file_name = normalized.split("/")[-1] or normalized
        if _looks_absolute_path(raw):
            out["original_path"] = raw
            out["file"] = file_name
            out["path"] = file_name
            return out
        rel = normalized[2:] if normalized.startswith("./") else normalized
        out["file"] = rel or file_name
        if isinstance(out.get("path"), str):
            out["path"] = out["file"]
        return out

    return value


def _normalize_message_attachments(value: object) -> list:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        normalized = _normalize_attachment_entry(item)
        if normalized in (None, "", []):
            continue
        out.append(normalized)
    return out


_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


def _safe_web_attachment_name(value: object) -> str:
    raw = str(value or "").strip().replace("\\", "/").split("/")[-1]
    raw = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", "_", raw).strip(" ._")
    return raw or "attachment"


def _resolve_web_attachment_path(attachment: object) -> Path | None:
    if not isinstance(attachment, dict):
        return None
    raw = str(attachment.get("path") or attachment.get("original_path") or "").strip()
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute() or not candidate.is_file():
        return None
    try:
        resolved = candidate.resolve()
        workspace_root = Path(BASE_PATH).resolve()
        resolved.relative_to(workspace_root)
        return resolved
    except Exception:
        return None


def _web_attachment_kind(name: str, mime_type: str) -> str:
    suffix = Path(name).suffix.lower()
    mime = str(mime_type or "").lower()
    if mime.startswith("image/") or suffix in _IMAGE_EXTENSIONS:
        return "image"
    if mime == "application/pdf" or suffix == ".pdf":
        return "pdf"
    return "file"


def _attachment_metadata(order_id: str, message_index: int, attachment_index: int, attachment: object) -> dict:
    item = attachment if isinstance(attachment, dict) else {"name": str(attachment or "Attachment")}
    name = _safe_web_attachment_name(item.get("name") or item.get("filename") or item.get("file") or item.get("path"))
    path = _resolve_web_attachment_path(item)
    mime_type = str(item.get("mime_type") or item.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    size = 0
    if path:
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
    kind = _web_attachment_kind(name, mime_type)
    base_url = f"/orders/{order_id}/attachments/{message_index}/{attachment_index}"
    return {
        "id": f"{message_index}:{attachment_index}",
        "name": name,
        "mime_type": mime_type,
        "size": size,
        "kind": kind,
        "downloadable": bool(path),
        "previewable": bool(path and kind == "image"),
        "download_url": f"{base_url}/download" if path else "",
        "preview_url": f"{base_url}/preview" if path and kind == "image" else "",
    }


def _load_order_messages(order_id: str) -> list[dict]:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT messages FROM orders WHERE id = ? AND status NOT IN ('deleted')", (order_id,))
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found.")
    return _parse_order_messages(row[0])


def _get_order_attachment(order_id: str, message_index: int, attachment_index: int) -> tuple[dict, Path]:
    messages = _load_order_messages(order_id)
    try:
        message = messages[int(message_index)]
        attachment = _normalize_message_attachments(message.get("attachments"))[int(attachment_index)]
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Attachment not found.") from exc
    if not isinstance(attachment, dict):
        attachment = {"name": str(attachment or "Attachment")}
    path = _resolve_web_attachment_path(attachment)
    if not path:
        raise HTTPException(status_code=404, detail="Attachment is not available for web download.")
    return attachment, path


def _normalize_messages_for_archive(messages: list) -> list:
    out = []
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        next_message = dict(message)
        next_message["attachments"] = _normalize_message_attachments(next_message.get("attachments"))
        out.append(next_message)
    return out


def _restore_message_attachment_paths(messages: list, target_folder: Path) -> list:
    out = []
    restored_count = 0
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        next_message = dict(message)
        attachments = []
        for attachment in _normalize_message_attachments(next_message.get("attachments")):
            if isinstance(attachment, dict):
                item = dict(attachment)
                raw_path = str(item.get("path") or item.get("file") or "").strip()
                if raw_path and not _looks_absolute_path(raw_path):
                    candidate = (target_folder / raw_path).resolve()
                    if candidate.exists():
                        item["path"] = str(candidate)
                        restored_count += 1
                attachments.append(item)
            else:
                raw = str(attachment or "").strip()
                candidate = (target_folder / raw).resolve() if raw and not _looks_absolute_path(raw) else None
                if candidate and candidate.exists():
                    attachments.append({"file": raw, "path": str(candidate)})
                    restored_count += 1
                else:
                    attachments.append(attachment)
        next_message["attachments"] = attachments
        out.append(next_message)
    if restored_count:
        print(f"[ATTACHMENT_RESTORE] restored_paths={restored_count} order_folder={target_folder}")
    return out


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
    """Used by RESTORE only — produces a unique folder name under Orders."""
    if not desired.exists():
        return desired
    parent = desired.parent
    stem = desired.name
    for i in range(1, 10000):
        cand = parent / f"{stem}__restored{i}"
        if not cand.exists():
            return cand
    raise OSError("could not allocate unique restore folder name")


def _archive_destination(folder_path: str | None, archive_root: Path) -> Path | None:
    """
    Compute where a folder *would* land after archiving, without touching the
    filesystem.  Returns None when the path cannot be mapped.
    """
    raw = str(folder_path or "").strip()
    if not raw:
        return None
    try:
        src = Path(raw).expanduser().resolve()
    except OSError:
        return None
    ar = archive_root.resolve()
    ob = ORDERS_PATH.resolve()
    if _path_under_base(src, ar):
        return src  # already inside archive root
    if not _path_under_base(src, ob):
        return None
    try:
        rel = src.relative_to(ob)
    except ValueError:
        return None
    return (ar / rel).resolve()


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

    try:
        shutil.move(str(src), str(desired))
    except OSError as exc:
        print(f"[ORDER_FOLDER_ARCHIVE_FAIL] order_id={order_id} error={exc}")
        return None

    final_path = str(desired.resolve())
    print(f"[ORDER_FOLDER_MOVED] order_id={order_id} from_path={src} to_path={final_path}")
    return final_path


def _write_manifest(
    order_id: str,
    order_number: str | None,
    buyer_name: str | None,
    buyer_email: str | None,
    shipping_address: str | None,
    pet_name: str | None,
    src_folder: Path,
) -> bool:
    """
    Write manifest.json into the order folder before archiving.

    Strict minimal contract — only the fields needed for search and restore.
    Everything else (messages, price, dates, notes) stays in conversation.json.
    Returns False on write failure.
    """
    manifest = {
        "schema_version": 1,
        "order_id":        order_id,
        "order_number":    order_number,
        "buyer_name":      buyer_name,
        "buyer_email":     buyer_email,
        "shipping_address": shipping_address,
        "pet_name":        pet_name,
        "folder_name":     src_folder.name,
        "folder_path":     str(src_folder),
        "archived_at":     _now_iso_utc(),
        "search_blob": " ".join(
            str(v or "") for v in (
                order_number, buyer_name, buyer_email, shipping_address, pet_name
            )
        ).lower(),
    }
    manifest_path = src_folder / "manifest.json"
    try:
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[ARCHIVE_MANIFEST_SAVED] order_id={order_id} path={manifest_path}")
        return True
    except OSError as exc:
        print(f"[ARCHIVE_MANIFEST_FAIL] order_id={order_id} error={exc}")
        return False


def _archive_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value)
    return str(value)


def _extract_archive_text_from_messages(messages: list) -> tuple[str, str]:
    conversation_parts: list[str] = []
    notes_parts: list[str] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        for key in ("subject", "sender", "sender_name", "sender_email", "from", "to", "body", "preview_text", "preview"):
            text = _archive_text(msg.get(key)).strip()
            if text:
                conversation_parts.append(text)
        for key in ("notes", "note", "order_notes", "gift_message"):
            text = _archive_text(msg.get(key)).strip()
            if text:
                notes_parts.append(text)
    return "\n".join(conversation_parts), "\n".join(notes_parts)


def _extract_archive_text_from_items(cur, order_id: str) -> tuple[str, str]:
    product_parts: list[str] = []
    notes_parts: list[str] = []
    try:
        cur.execute(
            """
            SELECT quantity, price, custom_1, custom_2, custom_3, custom_4, custom_5, custom_6,
                   order_notes, gift_message, item_status
            FROM items
            WHERE order_id = ?
            ORDER BY item_index ASC
            """,
            (order_id,),
        )
        for row in cur.fetchall():
            quantity, price, *rest = row
            custom_values = rest[:6]
            order_notes, gift_message, item_status = rest[6:]
            product_parts.extend(_archive_text(v).strip() for v in (quantity, price, *custom_values, item_status) if _archive_text(v).strip())
            notes_parts.extend(_archive_text(v).strip() for v in (order_notes, gift_message) if _archive_text(v).strip())
    except Exception as exc:
        print(f"[ARCHIVE_INDEX_ITEMS_WARN] order_id={order_id} error={exc}")
    return "\n".join(product_parts), "\n".join(notes_parts)


def _build_archive_index_row(
    *,
    manifest: dict,
    folder_path: Path,
    conversation: dict | None = None,
    product_text: str = "",
    notes_text: str = "",
) -> dict:
    conversation = conversation if isinstance(conversation, dict) else {}
    messages = conversation.get("messages")
    if not isinstance(messages, list):
        messages = []
    conversation_text, conversation_notes = _extract_archive_text_from_messages(messages)
    merged_notes = "\n".join(part for part in (notes_text, conversation_notes) if part)
    archived_at = str(manifest.get("archived_at") or conversation.get("archived_at") or _now_iso_utc())
    original_order_id = str(manifest.get("order_id") or conversation.get("order_id") or "").strip()
    archive_id = str(manifest.get("archive_id") or original_order_id or str(uuid.uuid4())).strip()
    row = {
        "archive_id": archive_id,
        "original_order_id": original_order_id,
        "order_number": str(manifest.get("order_number") or conversation.get("order_number") or "").strip(),
        "buyer_name": str(manifest.get("buyer_name") or "").strip(),
        "buyer_email": str(manifest.get("buyer_email") or "").strip(),
        "shipping_address": str(manifest.get("shipping_address") or "").strip(),
        "pet_name": str(manifest.get("pet_name") or "").strip(),
        "order_date": str(manifest.get("order_date") or "").strip(),
        "archived_at": archived_at,
        "archive_status": "archived",
        "folder_name": str(manifest.get("folder_name") or folder_path.name).strip(),
        "folder_path": str(folder_path.resolve()),
        "manifest_path": str((folder_path / "manifest.json").resolve()),
        "conversation_path": str((folder_path / "conversation.json").resolve()),
        "product_text": product_text,
        "notes_text": merged_notes,
        "conversation_text": conversation_text,
        "updated_at": _now_iso_utc(),
    }
    row["search_blob"] = " ".join(
        " ".join(expand_search_value_aliases(row.get(key))) for key in (
            "order_number", "buyer_name", "buyer_email", "shipping_address", "pet_name",
            "order_date", "archived_at", "folder_name", "folder_path", "product_text",
            "notes_text", "conversation_text",
        )
    ).lower()
    return row


def _upsert_archive_index(cur, row: dict) -> None:
    cur.execute(
        """
        INSERT INTO archive_orders (
            archive_id, original_order_id, order_number, buyer_name, buyer_email,
            shipping_address, pet_name, order_date, archived_at, archive_status,
            folder_name, folder_path, manifest_path, conversation_path,
            product_text, notes_text, conversation_text, search_blob, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(archive_id) DO UPDATE SET
            original_order_id=excluded.original_order_id,
            order_number=excluded.order_number,
            buyer_name=excluded.buyer_name,
            buyer_email=excluded.buyer_email,
            shipping_address=excluded.shipping_address,
            pet_name=excluded.pet_name,
            order_date=excluded.order_date,
            archived_at=excluded.archived_at,
            archive_status=excluded.archive_status,
            folder_name=excluded.folder_name,
            folder_path=excluded.folder_path,
            manifest_path=excluded.manifest_path,
            conversation_path=excluded.conversation_path,
            product_text=excluded.product_text,
            notes_text=excluded.notes_text,
            conversation_text=excluded.conversation_text,
            search_blob=excluded.search_blob,
            updated_at=excluded.updated_at
        """,
        (
            row.get("archive_id"), row.get("original_order_id"), row.get("order_number"),
            row.get("buyer_name"), row.get("buyer_email"), row.get("shipping_address"),
            row.get("pet_name"), row.get("order_date"), row.get("archived_at"),
            row.get("archive_status"), row.get("folder_name"), row.get("folder_path"),
            row.get("manifest_path"), row.get("conversation_path"), row.get("product_text"),
            row.get("notes_text"), row.get("conversation_text"), row.get("search_blob"),
            row.get("updated_at"),
        ),
    )
    cur.execute("DELETE FROM archive_orders_fts WHERE archive_id = ?", (row.get("archive_id"),))
    cur.execute(
        """
        INSERT INTO archive_orders_fts (
            archive_id, order_number, buyer_name, buyer_email, shipping_address,
            pet_name, order_date, product_text, notes_text, conversation_text, search_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row.get("archive_id"), row.get("order_number"), row.get("buyer_name"),
            row.get("buyer_email"), row.get("shipping_address"), row.get("pet_name"),
            row.get("order_date"), row.get("product_text"), row.get("notes_text"),
            row.get("conversation_text"), row.get("search_blob"),
        ),
    )


def _index_archive_folder(cur, folder: Path, *, product_text: str = "", notes_text: str = "") -> bool:
    manifest_path = folder / "manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(manifest, dict):
        return False
    conversation = {}
    conv_path = folder / "conversation.json"
    if conv_path.is_file():
        try:
            parsed = json.loads(conv_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                conversation = parsed
        except (OSError, json.JSONDecodeError):
            conversation = {}
    row = _build_archive_index_row(
        manifest=manifest,
        folder_path=folder,
        conversation=conversation,
        product_text=product_text,
        notes_text=notes_text,
    )
    _upsert_archive_index(cur, row)
    return True


def _delete_archive_index_for_folder(cur, folder_path: Path) -> None:
    resolved = str(folder_path.resolve())
    cur.execute("SELECT archive_id FROM archive_orders WHERE folder_path = ?", (resolved,))
    rows = cur.fetchall()
    for row in rows:
        cur.execute("DELETE FROM archive_orders_fts WHERE archive_id = ?", (row[0],))
    cur.execute("DELETE FROM archive_orders WHERE folder_path = ?", (resolved,))


def _offload_order_to_filesystem(
    order_id: str,
    folder_path: str | None,
    archive_root: Path,
    cur,
) -> bool:
    """
    Idempotent archive + hard-delete pipeline.

    Sequence:
      1. Read order fields from DB.
      2. Validate messages JSON.
      3. Persist email refs for inbox filtering.
      4. Idempotency check — if the archive destination already contains a
         matching manifest.json for this order_id, skip the folder move and
         go straight to DB cleanup.
      5. Mark status='archiving' so the order disappears from active views
         immediately and cannot be double-archived by a concurrent run.
      6. Write manifest.json + conversation.json into the source folder.
      7. shutil.move the folder to archive root.
      8. Hard-delete from DB (always runs after a successful move OR idempotency skip).

    Returns True when the order row was removed from DB.
    Returns False only when an unrecoverable error prevents safe deletion.
    """
    try:
        # ── Step 1: read order fields ─────────────────────────────────────
        cur.execute(
            """SELECT order_number, messages, source_eml_path, eml_path,
                      buyer_name, buyer_email, shipping_address, pet_name
               FROM orders WHERE id = ?""",
            (order_id,),
        )
        row = cur.fetchone()
        if not row:
            print(f"[ARCHIVE_SKIP] order_id={order_id} reason=not_found_in_db")
            return False
        (order_number, messages_raw, source_eml_path, eml_path,
         buyer_name, buyer_email, shipping_address, pet_name) = row

        # Derive pet_name from items.custom_1 when not set on the order directly.
        if not pet_name:
            cur.execute(
                "SELECT custom_1 FROM items WHERE order_id = ? "
                "ORDER BY item_index ASC LIMIT 1",
                (order_id,),
            )
            item_row = cur.fetchone()
            pet_name = (item_row[0] if item_row else None) or None

        # ── Step 2: validate messages JSON ───────────────────────────────
        messages_list: list = []
        if messages_raw:
            try:
                parsed = json.loads(messages_raw)
            except (json.JSONDecodeError, TypeError) as exc:
                print(
                    f"[ARCHIVE_CONVERSATION_INVALID] order_id={order_id} "
                    f"reason=json_parse_error error={exc}"
                )
                return False
            if not isinstance(parsed, list):
                print(
                    f"[ARCHIVE_CONVERSATION_INVALID] order_id={order_id} "
                    f"reason=messages_not_a_list type={type(parsed).__name__}"
                )
                return False
            messages_list = parsed

        product_text, item_notes_text = _extract_archive_text_from_items(cur, order_id)

        # ── Step 3: persist email refs for inbox filter ──────────────────
        refs: list[str] = []
        for eml in (source_eml_path, eml_path):
            refs.extend(_processed_ref_variants(eml))
            uid = _extract_eml_uid(eml)
            if uid:
                refs.append(uid)
        for msg in messages_list:
            if str(msg.get("type") or msg.get("direction") or "").lower() != "inbound":
                continue
            for field in (msg.get("email_id"), msg.get("message_id"), msg.get("id")):
                refs.extend(_processed_ref_variants(field))
        if refs:
            _persist_processed_refs(refs)

        # ── Step 4: idempotency check ────────────────────────────────────
        folder_already_archived = False
        dest_path: str | None = None

        if folder_path:
            dest = _archive_destination(folder_path, archive_root)
            src_folder = Path(folder_path).expanduser().resolve()

            if dest is not None and dest.is_dir():
                # Destination already exists — check if it belongs to this order.
                manifest_path = dest / "manifest.json"
                if manifest_path.is_file():
                    try:
                        m = json.loads(manifest_path.read_text(encoding="utf-8"))
                        if str(m.get("order_id") or "").strip() == order_id:
                            print(
                                f"[ARCHIVE_IDEMPOTENT] order_id={order_id} "
                                f"folder already archived at {dest} — skipping move, cleaning DB"
                            )
                            folder_already_archived = True
                            dest_path = str(dest)
                        else:
                            print(
                                f"[ARCHIVE_ABORT] order_id={order_id} "
                                f"destination {dest} exists but belongs to a different order — aborting"
                            )
                            return False
                    except (OSError, json.JSONDecodeError) as exc:
                        print(
                            f"[ARCHIVE_ABORT] order_id={order_id} "
                            f"could not read manifest at {dest}: {exc}"
                        )
                        return False
                else:
                    print(
                        f"[ARCHIVE_ABORT] order_id={order_id} "
                        f"destination {dest} exists but has no manifest.json — aborting to avoid data loss"
                    )
                    return False

            if not folder_already_archived:
                if not src_folder.is_dir():
                    print(
                        f"[ARCHIVE_SKIP] order_id={order_id} "
                        f"reason=source_folder_not_found path={src_folder}"
                    )
                    return False

        # ── Step 5: mark as 'archiving' to prevent concurrent re-archive ─
        if not folder_already_archived:
            cur.execute(
                "UPDATE orders SET status = 'archiving' WHERE id = ?",
                (order_id,),
            )

        # ── Step 6: write manifest.json + conversation.json ──────────────
        if folder_path and not folder_already_archived:
            if not _write_manifest(
                order_id=order_id,
                order_number=order_number,
                buyer_name=buyer_name,
                buyer_email=buyer_email,
                shipping_address=shipping_address,
                pet_name=pet_name,
                src_folder=src_folder,
            ):
                # Revert status so the order reappears and can be retried.
                cur.execute(
                    "UPDATE orders SET status = 'active' WHERE id = ?",
                    (order_id,),
                )
                return False

            conv_path = src_folder / "conversation.json"
            try:
                archive_messages = _normalize_messages_for_archive(messages_list)
                conv_data = {
                    "order_id": order_id,
                    "order_number": order_number,
                    "archived_at": _now_iso_utc(),
                    "source_eml_path": source_eml_path,
                    "eml_path": eml_path,
                    "messages": archive_messages,
                }
                conv_path.write_text(
                    json.dumps(conv_data, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                print(f"[ARCHIVE_CONVERSATION_SAVED] order_id={order_id} path={conv_path}")
            except OSError as exc:
                print(f"[ARCHIVE_CONVERSATION_FAIL] order_id={order_id} error={exc}")
                cur.execute(
                    "UPDATE orders SET status = 'active' WHERE id = ?",
                    (order_id,),
                )
                return False

        # ── Step 7: move folder ───────────────────────────────────────────
        if folder_path and not folder_already_archived:
            moved = _move_order_folder_for_archive(order_id, folder_path, archive_root)
            if moved is None:
                cur.execute(
                    "UPDATE orders SET status = 'active' WHERE id = ?",
                    (order_id,),
                )
                return False
            dest_path = moved

        if dest_path:
            archive_folder = Path(dest_path).expanduser().resolve()
            try:
                if _index_archive_folder(cur, archive_folder, product_text=product_text, notes_text=item_notes_text):
                    print(f"[ARCHIVE_INDEX_UPSERT] order_id={order_id} path={archive_folder}")
                else:
                    print(f"[ARCHIVE_INDEX_SKIP] order_id={order_id} reason=missing_manifest path={archive_folder}")
            except Exception as exc:
                print(f"[ARCHIVE_INDEX_FAIL] order_id={order_id} error={exc}")
                return False

        # ── Step 8: hard-delete — always runs after move or idempotency skip
        cur.execute("DELETE FROM items WHERE order_id = ?", (order_id,))
        cur.execute("DELETE FROM orders WHERE id = ?", (order_id,))
        print(
            f"[ORDER_ARCHIVED_TO_FILESYSTEM] order_id={order_id} "
            f"from_path={folder_path or ''} to_path={dest_path or ''}"
        )
        return True

    except Exception as exc:
        print(f"[ARCHIVE_ERROR] order_id={order_id} unhandled exception: {exc}")
        raise


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


def _restore_folder_target(source_folder: Path, archive_root: Path) -> Path:
    """
    Build the restore target under ORDERS_PATH preserving the relative archive path.
    Example: C:/Spaila/archive/2026/april/Name -> C:/Spaila/orders/2026/april/Name
    """
    src = source_folder.resolve()
    ar = archive_root.resolve()
    if not _path_under_base(src, ar):
        raise ValueError("folder_path is outside archive root")
    rel = src.relative_to(ar)
    desired = ORDERS_PATH.resolve() / rel
    desired.parent.mkdir(parents=True, exist_ok=True)
    return _first_unique_archive_destination(desired)


def _collect_processed_refs_for_restore(messages: list, source_eml_path: str | None, eml_path: str | None) -> list[str]:
    refs: list[str] = []
    for eml in (source_eml_path, eml_path):
        refs.extend(_processed_ref_variants(eml))
        uid = _extract_eml_uid(eml)
        if uid:
            refs.append(uid)
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if str(msg.get("type") or msg.get("direction") or "").lower() != "inbound":
            continue
        for field in (msg.get("message_id"), msg.get("email_id"), msg.get("id")):
            refs.extend(_processed_ref_variants(field))
    return refs


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
    _require_feature("parser")
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
            id, order_number, order_date, buyer_name, shipping_name,
            buyer_email, shipping_address, phone_number, ship_by, pet_name,
            status, created_at, last_activity_at, updated_at,
            source_eml_path, eml_path, order_folder_path,
            platform, is_gift, gift_wrap
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        order_id,
        order_number,
        order_date,
        buyer_name,
        order.get("shipping_name") or None,
        order.get("buyer_email"),
        order.get("shipping_address"),
        order.get("phone_number") or None,
        ship_by,
        order.get("pet_name") or None,
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

    if source_eml_path:
        try:
            from server.inbox.email_archive import archive_existing_eml

            archive_existing_eml(
                source_eml_path,
                linked_order_id=order_id,
                status="processed_archived",
            )
        except Exception as exc:
            print(f"[EMAIL_ARCHIVE_ORDER_CREATE_FAIL] order_id={order_id} source={source_eml_path!r} error={exc}")

    print(f"SAVED TO DB: {order_id} {order_number} -> {order_folder_path}")

    return {
        "id": order_id,
        "status": "created",
        "created_at": created_at,
        "order_folder_path": order_folder_path,
    }


@router.post("/orders/create-manual")
def create_manual_order(payload: dict):
    _require_feature("manual_order_creation")
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
            id, order_number, order_date, buyer_name, shipping_name,
            buyer_email, shipping_address, phone_number, ship_by, pet_name,
            status, created_at, last_activity_at, updated_at,
            source_eml_path, eml_path, order_folder_path,
            platform, is_gift, gift_wrap
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        order_id,
        order_number,
        order_date,
        buyer_name,
        payload.get("shipping_name") or None,
        payload.get("buyer_email") or None,
        payload.get("shipping_address") or None,
        payload.get("phone_number") or None,
        payload.get("ship_by") or None,
        payload.get("pet_name") or None,
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
def list_orders(status: str = "", search: str = "", sort: str = "newest"):
    conn = get_conn()
    cur = conn.cursor()

    filters = ["orders.status NOT IN ('deleted', 'archiving')"]
    values: list[object] = []
    status_filter = str(status or "").strip().lower()
    completed_predicate = """
        (
            LOWER(COALESCE(items.item_status, '')) IN ('completed', 'complete', 'done')
            OR (
                (items.item_status IS NULL OR TRIM(items.item_status) = '')
                AND LOWER(COALESCE(orders.status, '')) IN ('completed', 'complete', 'done')
            )
        )
    """
    if status_filter == "active":
        filters.append(f"NOT {completed_predicate}")
        filters.append("LOWER(COALESCE(orders.status, 'active')) NOT IN ('archived')")
    elif status_filter in ("completed", "complete", "done"):
        filters.append(completed_predicate)
    elif status_filter == "archived":
        filters.append("LOWER(orders.status) = 'archived'")

    search_value = str(search or "").strip().lower()
    search_is_date_like = bool(build_date_search_aliases(search_value))
    if search_value and not search_is_date_like:
        like = f"%{search_value}%"
        filters.append(
            """
            (
                LOWER(COALESCE(orders.order_number, '')) LIKE ?
                OR LOWER(COALESCE(orders.buyer_name, '')) LIKE ?
                OR LOWER(COALESCE(orders.shipping_name, '')) LIKE ?
                OR LOWER(COALESCE(orders.buyer_email, '')) LIKE ?
                OR LOWER(COALESCE(orders.shipping_address, '')) LIKE ?
                OR LOWER(COALESCE(orders.phone_number, '')) LIKE ?
                OR LOWER(COALESCE(orders.pet_name, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_1, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_2, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_3, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_4, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_5, '')) LIKE ?
                OR LOWER(COALESCE(items.custom_6, '')) LIKE ?
                OR LOWER(COALESCE(orders.order_date, '')) LIKE ?
                OR LOWER(COALESCE(orders.ship_by, '')) LIKE ?
            )
            """
        )
        values.extend([like] * 15)

    sort_value = str(sort or "newest").strip().lower()
    order_by = {
        "newest": "orders.created_at DESC, items.item_index ASC",
        "oldest": "orders.created_at ASC, items.item_index ASC",
        "ship_by": "orders.ship_by ASC, orders.created_at DESC, items.item_index ASC",
        "order_date": "orders.order_date DESC, orders.created_at DESC, items.item_index ASC",
        "buyer": "orders.buyer_name COLLATE NOCASE ASC, orders.created_at DESC, items.item_index ASC",
        "status": "orders.status COLLATE NOCASE ASC, orders.created_at DESC, items.item_index ASC",
    }.get(sort_value, "orders.created_at DESC, items.item_index ASC")

    where_clause = " AND ".join(filters)
    cur.execute(f"""
        SELECT
            items.id,
            orders.id,
            orders.order_number,
            orders.buyer_name,
            orders.shipping_name,
            orders.buyer_email,
            orders.shipping_address,
            orders.phone_number,
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
            orders.messages,
            orders.pet_name,
            orders.updated_at
        FROM items
        JOIN orders ON items.order_id = orders.id
        WHERE {where_clause}
        ORDER BY {order_by}
    """, values)

    rows = cur.fetchall()
    conn.close()

    results = [
        {
            "id": r[0],
            "order_id": r[1],
            "order_number": r[2],
            "buyer_name": r[3],
            "shipping_name": r[4],
            "buyer_email": r[5],
            "shipping_address": r[6],
            "phone_number": r[7],
            "order_date": r[8],
            "ship_by": r[9],
            "status": r[10],
            "price": r[11],
            "quantity": r[12],
            "custom_1": r[13],
            "custom_2": r[14],
            "custom_3": r[15],
            "custom_4": r[16],
            "custom_5": r[17],
            "custom_6": r[18],
            "order_folder_path": r[19],
            "source_eml_path": r[20],
            "eml_path": r[21],
            "gift_message": r[22],
            "order_notes": r[23],
            "item_index": r[24],
            "platform":    r[25] or "unknown",
            "item_status": r[26] or None,
            "is_gift": bool(r[27]),
            "gift_wrap": bool(r[28]),
            "messages": _parse_order_messages(r[29]),
            "pet_name": r[30] or r[13],
            "updated_at": r[31],
        }
        for r in rows
    ]
    if search_value and search_is_date_like:
        results = [
            row for row in results
            if normalized_search_matches(
                search_value,
                (
                    row.get("order_number"), row.get("buyer_name"), row.get("shipping_name"), row.get("buyer_email"),
                    row.get("shipping_address"), row.get("phone_number"), row.get("pet_name"), row.get("custom_1"),
                    row.get("custom_2"), row.get("custom_3"), row.get("custom_4"),
                    row.get("custom_5"), row.get("custom_6"), row.get("order_date"),
                    row.get("ship_by"),
                ),
            )
        ]
    return results


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
            shipping_name,
            buyer_email,
            shipping_address,
            phone_number,
            order_date,
            ship_by,
            status,
            order_folder_path,
            messages,
            source_eml_path,
            eml_path,
            platform,
            is_gift,
            gift_wrap,
            last_activity_at,
            updated_at,
            pet_name
        FROM orders
        WHERE id = ? AND status NOT IN ('deleted')
        """,
        (order_id,),
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Order not found.")
    cur.execute(
        """
        SELECT
            id,
            item_index,
            quantity,
            price,
            custom_1,
            custom_2,
            custom_3,
            custom_4,
            custom_5,
            custom_6,
            order_notes,
            gift_message,
            item_status
        FROM items
        WHERE order_id = ?
        ORDER BY item_index ASC
        """,
        (order_id,),
    )
    item_rows = cur.fetchall()
    conn.close()
    return {
        "order_id": row[0],
        "id": row[0],
        "order_number": row[1],
        "buyer_name": row[2],
        "shipping_name": row[3],
        "buyer_email": row[4],
        "shipping_address": row[5],
        "phone_number": row[6],
        "order_date": row[7],
        "ship_by": row[8],
        "status": row[9],
        "order_folder_path": row[10],
        "messages": _parse_order_messages(row[11]),
        "source_eml_path": row[12],
        "eml_path": row[13],
        "platform": row[14] or "unknown",
        "is_gift": bool(row[15]),
        "gift_wrap": bool(row[16]),
        "last_activity_at": row[17],
        "updated_at": row[18],
        "pet_name": row[19] or (item_rows[0][4] if item_rows else None),
        "items": [
            {
                "id": item[0],
                "item_index": item[1],
                "quantity": item[2],
                "price": item[3],
                "custom_1": item[4],
                "custom_2": item[5],
                "custom_3": item[6],
                "custom_4": item[7],
                "custom_5": item[8],
                "custom_6": item[9],
                "order_notes": item[10],
                "gift_message": item[11],
                "item_status": item[12],
            }
            for item in item_rows
        ],
    }


@router.get("/orders/{order_id}/attachments")
def list_order_attachments(order_id: str):
    messages = _load_order_messages(order_id)
    attachments: list[dict] = []
    for message_index, message in enumerate(messages):
        for attachment_index, attachment in enumerate(_normalize_message_attachments(message.get("attachments"))):
            attachments.append(_attachment_metadata(order_id, message_index, attachment_index, attachment))
    return {"order_id": order_id, "attachments": attachments}


@router.get("/orders/{order_id}/attachments/{message_index}/{attachment_index}/download")
def download_order_attachment(order_id: str, message_index: int, attachment_index: int):
    attachment, path = _get_order_attachment(order_id, message_index, attachment_index)
    name = _safe_web_attachment_name(
        attachment.get("name") or attachment.get("filename") or attachment.get("file") or path.name
    )
    media_type = str(attachment.get("mime_type") or attachment.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=name)


@router.get("/orders/{order_id}/attachments/{message_index}/{attachment_index}/preview")
def preview_order_attachment(order_id: str, message_index: int, attachment_index: int):
    attachment, path = _get_order_attachment(order_id, message_index, attachment_index)
    name = _safe_web_attachment_name(
        attachment.get("name") or attachment.get("filename") or attachment.get("file") or path.name
    )
    media_type = str(attachment.get("mime_type") or attachment.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    if _web_attachment_kind(name, media_type) != "image":
        raise HTTPException(status_code=404, detail="Attachment preview is not available.")
    return FileResponse(path, media_type=media_type)


@router.post("/orders/update-full")
def update_full(payload: dict):
    conn = get_conn()
    cur = conn.cursor()
    order_id = payload.get("order_id")
    new_status = str(payload.get("status") or "active").lower()
    if order_id:
        _conflict_if_stale(cur, order_id, payload.get("base_updated_at"))
    touch_ts = _next_order_touch_ts(cur, order_id) if order_id else datetime.utcnow().isoformat()

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
        ("shipping_name", payload.get("shipping_name") or None),
        ("buyer_email", payload.get("buyer_email") or None),
        ("shipping_address", payload.get("shipping_address") or None),
        ("phone_number", payload.get("phone_number") or None),
        ("order_date", payload.get("order_date")),
        ("ship_by", payload.get("ship_by")),
        ("pet_name", payload.get("pet_name") or None),
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
            gift_message = ?,
            item_status  = ?
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
        payload.get("item_status") or None,
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
        "source",
        "delivery_status",
        "direction",
        "type",
    ):
        if optional_key in message:
            next_message[optional_key] = message.get(optional_key)
    next_message["attachments"] = _normalize_message_attachments(next_message.get("attachments"))

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
    """
    Offload eligible orders to the filesystem archive and hard-delete them from
    the database.  An order qualifies when it has been inactive for more than
    `days` days.  The folder is moved first; if the move fails the order is
    skipped and the DB row is left untouched.
    """
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
        WHERE status NOT IN ('deleted', 'archived', 'archiving')
        """
    )
    rows = cur.fetchall()
    now = datetime.now(timezone.utc)
    archived: list[str] = []

    for row in rows:
        oid, created_at, last_activity_at, updated_at, _status, folder_path = row
        ref_dt, _ref_field, ref_raw = _archive_reference_dt(last_activity_at, updated_at, created_at)
        elapsed_days = (now - ref_dt).total_seconds() / 86400.0
        if elapsed_days <= float(days_n):
            continue
        ok = _offload_order_to_filesystem(oid, folder_path, archive_root, cur)
        if ok:
            print(
                f"[ORDER_AUTO_ARCHIVED] order_id={oid} reference_date={ref_raw} "
                f"days_elapsed={elapsed_days:.4f} threshold={days_n}"
            )
            archived.append(oid)
        else:
            print(
                f"[ORDER_AUTO_ARCHIVE_SKIP] order_id={oid} reason=folder_move_failed"
            )

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


def _create_inbox_event(
    cur,
    *,
    event_type: str,
    order_id: str,
    order_number: str | None,
    buyer_name: str | None,
    preview: str | None,
    timestamp: str | None,
) -> str:
    """
    Insert one row into inbox_events and return its id.
    Caller is responsible for conn.commit().
    """
    event_id = str(uuid.uuid4())
    now = _now_iso_utc()
    cur.execute(
        """
        INSERT INTO inbox_events (id, type, order_id, order_number, buyer_name,
                                  preview, timestamp, unread, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        """,
        (
            event_id,
            event_type,
            order_id or "",
            order_number or "",
            buyer_name or "",
            (str(preview or "")[:140]).strip(),
            timestamp or now,
            now,
        ),
    )
    return event_id


@router.get("/inbox/events")
def list_inbox_events():
    """Return all inbox events, newest first."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, type, order_id, order_number, buyer_name,
               preview, timestamp, unread, created_at
        FROM inbox_events
        ORDER BY created_at DESC
        LIMIT 500
        """
    )
    rows = cur.fetchall()
    conn.close()
    return [
        {
            "id":           r[0],
            "type":         r[1],
            "order_id":     r[2],
            "order_number": r[3],
            "buyer_name":   r[4],
            "preview":      r[5],
            "timestamp":    r[6],
            "unread":       bool(r[7]),
            "created_at":   r[8],
        }
        for r in rows
    ]


@router.patch("/inbox/events/{event_id}/read")
def mark_event_read(event_id: str):
    """Mark a single inbox event as read."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE inbox_events SET unread = 0 WHERE id = ?", (event_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.delete("/inbox/events/{event_id}")
def delete_inbox_event(event_id: str):
    """Remove an inbox event."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM inbox_events WHERE id = ?", (event_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.get("/inbox/processed-refs")
def get_processed_refs():
    """
    Return the email refs persisted to disk during filesystem archive offloads.
    The frontend merges these into localStorage on startup so inbox filtering
    works even when the Workspace never loaded the archived order.
    """
    fp = BASE_PATH / PROCESSED_REFS_FILENAME
    try:
        if fp.is_file():
            data = json.loads(fp.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return {"refs": data}
    except (OSError, json.JSONDecodeError):
        pass
    return {"refs": []}


@router.get("/orders/archive/search")
def search_archive(q: str = "", status: str = "archived", include_paths: bool = True):
    """
    Indexed archive search.  Falls back to an empty list when no index rows exist;
    use /orders/archive/reindex to backfill older archive folders.
    """
    query = (q or "").strip().lower()
    status_value = str(status or "archived").strip().lower()
    query_is_date_like = bool(build_date_search_aliases(query))
    conn = get_conn()
    cur = conn.cursor()
    params: list[str] = []
    if query and not query_is_date_like:
        fts_query = " ".join(part.replace('"', '""') + "*" for part in query.split() if part.strip())
        params.append(fts_query)
        where = "ao.archive_id IN (SELECT archive_id FROM archive_orders_fts WHERE archive_orders_fts MATCH ?)"
    else:
        where = "1 = 1"
    if status_value not in ("all", ""):
        where += " AND COALESCE(ao.archive_status, 'archived') = ?"
        params.append(status_value)
    cur.execute(
        f"""
        SELECT ao.archive_id, ao.original_order_id, ao.order_number, ao.buyer_name, ao.buyer_email,
               ao.shipping_address, ao.pet_name, ao.order_date, ao.archived_at, ao.archive_status,
               ao.folder_name, ao.folder_path, ao.manifest_path, ao.conversation_path,
               ao.product_text, ao.notes_text, ao.conversation_text
        FROM archive_orders ao
        WHERE {where}
        ORDER BY ao.archived_at DESC
        LIMIT 200
        """,
        params,
    )
    rows = cur.fetchall()
    conn.close()
    results: list[dict] = []
    for row in rows:
        searchable_fields = {
            "order_number": row[2],
            "buyer_name": row[3],
            "buyer_email": row[4],
            "shipping_address": row[5],
            "pet_name": row[6],
            "order_date": row[7],
            "product": row[14],
            "notes": row[15],
            "conversation": row[16],
        }
        if query_is_date_like and not normalized_search_matches(query, searchable_fields.values()):
            continue
        match_fields = [
            key for key, value in searchable_fields.items()
            if query and normalized_search_matches(query, [value])
        ]
        snippet_source = next((str(searchable_fields[key] or "") for key in match_fields if str(searchable_fields[key] or "").strip()), "")
        results.append({
            "source": "archived",
            "archive_id": row[0],
            "order_id": row[1],
            "original_order_id": row[1],
            "order_number": row[2],
            "buyer_name": row[3],
            "buyer_email": row[4],
            "shipping_address": row[5],
            "pet_name": row[6],
            "order_date": row[7],
            "archived_at": row[8],
            "status": row[9],
            "folder_name": row[10],
            **({
                "folder_path": row[11],
                "manifest_path": row[12],
                "conversation_path": row[13],
            } if include_paths else {}),
            "product_text": row[14],
            "notes_text": row[15],
            "conversation_text": row[16],
            "match_fields": match_fields,
            "snippet": snippet_source[:240],
        })
    return results


@router.post("/orders/archive/reindex")
def reindex_archive():
    archive_root = _resolve_archive_root({})
    conn = get_conn()
    cur = conn.cursor()
    scanned = 0
    indexed = 0
    try:
        cur.execute("DELETE FROM archive_orders")
        cur.execute("DELETE FROM archive_orders_fts")
        for manifest_path in archive_root.rglob("manifest.json"):
            scanned += 1
            folder = manifest_path.parent
            if _index_archive_folder(cur, folder):
                indexed += 1
        conn.commit()
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Archive reindex failed: {exc}")
    finally:
        conn.close()
    return {"success": True, "scanned": scanned, "indexed": indexed}


@router.post("/orders/{order_id}/offload-to-filesystem")
async def offload_order_to_filesystem(order_id: str, request: Request):
    """
    Move the order's folder to the archive directory, then hard-delete the order
    and its items from the database.  The order will no longer appear in any app
    query; its files remain accessible on disk under the archive root.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    archive_root = _resolve_archive_root(body)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT order_folder_path FROM orders WHERE id = ? AND status NOT IN ('deleted')",
        (order_id,),
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Order not found.")
    folder_path = row[0]
    ok = _offload_order_to_filesystem(order_id, folder_path, archive_root, cur)
    if not ok:
        conn.close()
        raise HTTPException(
            status_code=500,
            detail="Folder move failed; order was not removed from the database.",
        )
    conn.commit()
    conn.close()
    return {"status": "ok", "order_id": order_id}


@router.post("/orders/{order_id}/archive-now")
async def archive_order_now(order_id: str):
    """
    Immediately run the full archive pipeline for a single order (dev / manual use).
    Equivalent to offload-to-filesystem with default archive root and no request body.
    """
    archive_root = _resolve_archive_root({})
    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT order_folder_path FROM orders WHERE id = ? AND status NOT IN ('deleted')",
            (order_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Order not found.")
        folder_path = row[0]
        ok = _offload_order_to_filesystem(order_id, folder_path, archive_root, cur)
        if not ok:
            raise HTTPException(
                status_code=500,
                detail="Archive failed; order was not removed from the database.",
            )
        conn.commit()
        print(f"[ORDER_FORCE_ARCHIVED] order_id={order_id}")
        return {"success": True, "order_id": order_id}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[ORDER_FORCE_ARCHIVE_FAIL] order_id={order_id} error={exc}")
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        conn.close()


@router.post("/orders/restore-from-archive")
async def restore_order_from_archive(request: Request):
    """
    Restore an archived order folder back into the active Orders tree.
    manifest.json is the PRIMARY source of order metadata.
    conversation.json is the SECONDARY source for message history.
    Fails cleanly if manifest.json is missing or invalid.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    raw_folder = str(body.get("folder_path") or "").strip()
    if not raw_folder:
        raise HTTPException(status_code=400, detail="folder_path is required.")

    archive_root = _resolve_archive_root({})
    source_folder = Path(raw_folder).expanduser()
    try:
        source_folder = source_folder.resolve()
    except OSError:
        raise HTTPException(status_code=400, detail="Invalid folder_path.")
    if not source_folder.exists() or not source_folder.is_dir():
        raise HTTPException(status_code=400, detail="folder_path does not exist.")
    if not _path_under_base(source_folder, archive_root):
        raise HTTPException(status_code=400, detail="folder_path must be under archive root.")

    # ── PRIMARY: manifest.json ──────────────────────────────────────────────
    manifest_path = source_folder / "manifest.json"
    if not manifest_path.is_file():
        raise HTTPException(status_code=400, detail="Missing manifest.json — cannot restore")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid manifest.json")
    if not isinstance(manifest, dict):
        raise HTTPException(status_code=400, detail="Invalid manifest.json")

    # ── Extract manifest fields (sole source of truth for order data) ──────
    restore_order_id = str(manifest.get("order_id") or "").strip()
    order_number     = str(manifest.get("order_number") or "").strip()
    if not restore_order_id or not order_number:
        raise HTTPException(status_code=400, detail="manifest.json missing order_id or order_number")

    buyer_name       = str(manifest.get("buyer_name")       or "").strip() or None
    buyer_email      = str(manifest.get("buyer_email")      or "").strip() or None
    shipping_address = str(manifest.get("shipping_address") or "").strip() or None
    pet_name         = str(manifest.get("pet_name")         or "").strip() or None

    # ── conversation.json: messages only (NOT used for order fields) ─────────
    conv_messages: list = []
    source_eml_path: str | None = None
    eml_path: str | None = None
    conv_path = source_folder / "conversation.json"
    if conv_path.is_file():
        try:
            conv = json.loads(conv_path.read_text(encoding="utf-8"))
            if isinstance(conv, dict):
                raw_msgs = conv.get("messages")
                if isinstance(raw_msgs, list):
                    conv_messages = raw_msgs
                source_eml_path = str(conv.get("source_eml_path") or "").strip() or None
                eml_path = str(conv.get("eml_path") or "").strip() or None
        except (OSError, json.JSONDecodeError):
            pass  # messages are best-effort; order identity comes from manifest

    target_folder = _restore_folder_target(source_folder, archive_root)

    # ── Move folder back FIRST ──────────────────────────────────────────────
    try:
        shutil.move(str(source_folder), str(target_folder))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Folder move failed: {exc}")
    conv_messages = _restore_message_attachment_paths(conv_messages, target_folder)

    now_iso = _now_iso_utc()
    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id FROM orders WHERE id = ?", (restore_order_id,))
        if cur.fetchone():
            restore_order_id = str(uuid.uuid4())

        cur.execute(
            """
            INSERT INTO orders (
                id, order_number, buyer_name, buyer_email, shipping_address, pet_name,
                status, created_at, last_activity_at, updated_at,
                order_folder_path, source_eml_path, eml_path, messages
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                restore_order_id,
                order_number,
                buyer_name,
                buyer_email,
                shipping_address,
                pet_name,
                now_iso,
                now_iso,
                now_iso,
                str(target_folder.resolve()),
                source_eml_path,
                eml_path,
                json.dumps(conv_messages),
            ),
        )
        # list_orders joins items; seed one placeholder item so the order is visible.
        cur.execute(
            """
            INSERT INTO items (
                id, order_id, item_index, quantity, price,
                custom_1, custom_2, custom_3, custom_4, custom_5, custom_6,
                item_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                restore_order_id,
                0,
                1, "",
                pet_name, None, None, None, None, None,
                "active",
            ),
        )
        refs = _collect_processed_refs_for_restore(conv_messages, source_eml_path, eml_path)
        if refs:
            _persist_processed_refs(refs)
        _delete_archive_index_for_folder(cur, source_folder)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        # Non-partial guarantee: move folder back to archive on DB failure.
        try:
            target_folder_resolved = target_folder.resolve()
            source_parent = source_folder.parent
            source_parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(target_folder_resolved), str(source_folder))
        except Exception as move_back_exc:
            print(
                f"[ORDER_RESTORE_ROLLBACK_MOVE_FAIL] from_path={target_folder} "
                f"to_path={source_folder} error={move_back_exc}"
            )
        raise HTTPException(status_code=500, detail=f"Restore failed: {exc}")
    finally:
        conn.close()

    print(
        f"[ORDER_RESTORED] order_id={restore_order_id} "
        f"from_path={source_folder} to_path={target_folder}"
    )
    return {"success": True, "order_id": restore_order_id}


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
    if any(key in payload for key in ("order_folder_path", "eml_path", "source_original_path")):
        _require_feature("helper")
    PATCHABLE = {
        "order_folder_path",
        "source_eml_path",
        "eml_path",
        "source_original_path",
        "status",
        "buyer_name",
        "shipping_name",
        "buyer_email",
        "shipping_address",
        "phone_number",
        "ship_by",
        "order_date",
        "pet_name",
        "is_gift",
        "gift_wrap",
    }

    fields = {k: v for k, v in payload.items() if k in PATCHABLE}
    conn = get_conn()
    cur = conn.cursor()
    _conflict_if_stale(cur, order_id, payload.get("base_updated_at"))

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
    touch_ts = _now_iso_utc()
    cur.execute("UPDATE items SET item_status = ? WHERE id = ?", (status, item_id))
    cur.execute(
        """
        UPDATE orders
        SET updated_at = ?, last_activity_at = ?
        WHERE id = (SELECT order_id FROM items WHERE id = ?)
        """,
        (touch_ts, touch_ts, item_id),
    )
    conn.commit()
    conn.close()
    return {"status": "ok"}
