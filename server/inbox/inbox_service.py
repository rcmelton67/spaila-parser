from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import re
import uuid
import hashlib
from email.parser import BytesParser
from email.policy import default
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict

from workspace_paths import ensure_workspace_layout

from .eml_writer import build_eml_path
from .imap_client import fetch_recent_messages


_WORKSPACE_DIRS = ensure_workspace_layout()
_INBOX_DIR = _WORKSPACE_DIRS["InboxModule"]
_HIDDEN_EMAILS_PATH = _WORKSPACE_DIRS["root"] / "hidden_emails.json"
_INTERNAL_DIR = _WORKSPACE_DIRS["root"] / ".spaila_internal"
_DEDUP_STORE_PATH = _INTERNAL_DIR / "dedup_store.json"
_DEDUP_TTL = timedelta(days=14)
_DEDUP_MAX_ENTRIES = 10_000
_ORDER_NUMBER_PATTERN = re.compile(r"\b\d{6,12}\b")


def _already_saved(email_id: str) -> bool:
    safe_email_id = "".join(ch for ch in str(email_id or "").strip() if ch.isalnum()) or "unknown"
    return any(_INBOX_DIR.glob(f"*_{safe_email_id}.eml"))


def _normalize_message_id(value: str) -> str:
    return str(value or "").strip().strip("<>").lower()


def _message_ref_keys(message_id: str, email_id: str) -> set[str]:
    refs: set[str] = set()
    normalized_message_id = _normalize_message_id(message_id)
    if normalized_message_id:
        refs.add(normalized_message_id)
    normalized_email_id = str(email_id or "").strip().lower()
    if normalized_email_id:
        refs.add(f"uid:{normalized_email_id}")
    return refs


def _load_dedup_store() -> dict[str, str]:
    now = datetime.now(timezone.utc)
    cutoff = now - _DEDUP_TTL
    try:
        data = json.loads(_DEDUP_STORE_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    raw_store = data.get("messages") if isinstance(data, dict) else data
    if not isinstance(raw_store, dict):
        raw_store = {}

    store: dict[str, str] = {}
    for key, timestamp in raw_store.items():
        normalized_key = _normalize_message_id(key)
        if not normalized_key:
            continue
        try:
            seen_at = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        except Exception:
            continue
        if seen_at >= cutoff:
            store[normalized_key] = seen_at.astimezone(timezone.utc).isoformat()

    if len(store) > _DEDUP_MAX_ENTRIES:
        oldest_first = sorted(store.items(), key=lambda item: item[1])
        store = dict(oldest_first[-_DEDUP_MAX_ENTRIES:])
    return store


def _save_dedup_store(store: dict[str, str]) -> None:
    _INTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        try:
            subprocess.run(["attrib", "+h", str(_INTERNAL_DIR)], check=False, capture_output=True)
        except Exception:
            pass
    if len(store) > _DEDUP_MAX_ENTRIES:
        oldest_first = sorted(store.items(), key=lambda item: item[1])
        store = dict(oldest_first[-_DEDUP_MAX_ENTRIES:])
    _DEDUP_STORE_PATH.write_text(json.dumps({
        "messages": store,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2), encoding="utf-8")


def _message_id_from_file(path_value: str) -> str:
    try:
        path = Path(path_value)
        if not path.is_file():
            return ""
        raw = path.read_bytes()
        return _message_id_from_raw(raw)
    except Exception:
        return ""


def _saved_uid_from_path(path_value: str) -> str:
    try:
        match = Path(path_value).name.split("_", 1)
        if len(match) != 2 or not match[1].lower().endswith(".eml"):
            return ""
        return match[1][:-4]
    except Exception:
        return ""


def _load_processed_order_refs() -> set[str]:
    refs: set[str] = set()
    db_path = Path("spaila.db")
    if not db_path.is_file():
        return refs
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute("SELECT source_eml_path, eml_path FROM orders")
        rows = cur.fetchall()
        conn.close()
    except Exception:
        return refs

    for source_eml_path, eml_path in rows:
        for path_value in [source_eml_path, eml_path]:
            if not path_value:
                continue
            message_id = _message_id_from_file(str(path_value))
            if message_id:
                refs.add(_normalize_message_id(message_id))
            saved_uid = _saved_uid_from_path(str(path_value))
            if saved_uid:
                refs.add(f"uid:{saved_uid.lower()}")
    return refs


def _load_hidden_email_ids() -> set[str]:
    try:
        data = json.loads(_HIDDEN_EMAILS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return set()
    values = data.get("hidden_emails") if isinstance(data, dict) else data
    if not isinstance(values, list):
        return set()
    return {str(value or "").strip() for value in values if str(value or "").strip()}


def _message_id_from_raw(raw_mime: bytes) -> str:
    try:
        headers = BytesParser(policy=default).parsebytes(raw_mime, headersonly=True)
        return str(headers.get("Message-ID") or "").strip().strip("<>")
    except Exception:
        return ""


def _extract_order_number_candidates(*values: str) -> list[str]:
    found = []
    seen = set()
    for value in values:
        source = str(value or "")
        for match in _ORDER_NUMBER_PATTERN.finditer(source):
            number = match.group(0).strip()
            if not number or number in seen:
                continue
            seen.add(number)
            found.append(number)
    return found


def _extract_email_address(value: str) -> str:
    source = str(value or "").strip()
    match = re.search(r"<([^<>\s]+@[^<>\s]+)>", source)
    if match:
        return match.group(1).strip().lower()
    match = re.search(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", source, re.IGNORECASE)
    return (match.group(0).strip().lower() if match else source.lower())


def _normalize_body(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def _subject_timestamp_hash(subject: str, timestamp: str) -> str:
    payload = f"{str(subject or '').strip().lower()}|{str(timestamp or '').strip()}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _extract_text_body(parsed_message) -> str:
    parts: list[str] = []
    try:
        if parsed_message.is_multipart():
            for part in parsed_message.walk():
                if part.get_content_maintype() == "multipart":
                    continue
                if part.get_content_type() != "text/plain":
                    continue
                try:
                    content = part.get_content()
                except Exception:
                    continue
                text = str(content or "").strip()
                if text:
                    parts.append(text)
        else:
            try:
                content = parsed_message.get_content()
            except Exception:
                content = ""
            text = str(content or "").strip()
            if text:
                parts.append(text)
    except Exception:
        return ""
    return "\n\n".join(parts).strip()


def _parse_message_timestamp(parsed_message) -> str:
    raw_date = str(parsed_message.get("Date") or "").strip()
    if raw_date:
        try:
            parsed = parsedate_to_datetime(raw_date)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat()
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


def _find_single_order_match(conn: sqlite3.Connection, candidates: list[str]) -> tuple[str, str, str]:
    if not candidates:
        return "", "", "no_candidates"
    normalized = [str(value or "").strip() for value in candidates if str(value or "").strip()]
    if not normalized:
        return "", "", "no_candidates"
    placeholders = ",".join("?" for _ in normalized)
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT id, order_number
        FROM orders
        WHERE status != 'deleted' AND order_number IN ({placeholders})
        """,
        normalized,
    )
    rows = cur.fetchall()
    unique_rows = {(str(row[0]).strip(), str(row[1]).strip()) for row in rows if str(row[0]).strip()}
    if len(unique_rows) != 1:
        if not unique_rows:
            return "", "", "no_order_match"
        return "", "", "ambiguous_order_match"
    order_id, order_number = unique_rows.pop()
    return order_id, order_number, "matched"


def _is_duplicate_inbound(
    existing: dict,
    incoming_body: str,
    incoming_sender: str,
    incoming_timestamp: str,
    incoming_email_id: str,
    incoming_message_id: str,
) -> str:
    if str(existing.get("type") or existing.get("direction") or "").lower() != "inbound":
        return ""
    existing_email_id = str(existing.get("email_id") or "").strip().lower()
    if incoming_email_id and existing_email_id and incoming_email_id == existing_email_id:
        return "same_email_id"
    existing_message_id = _normalize_message_id(existing.get("message_id") or existing.get("id") or "")
    if incoming_message_id and existing_message_id and incoming_message_id == existing_message_id:
        return "same_message_id"
    existing_body = _normalize_body(existing.get("body") or "")
    if not existing_body or existing_body != incoming_body:
        return ""
    existing_sender = _extract_email_address(existing.get("sender") or existing.get("from") or "")
    if incoming_sender and existing_sender and incoming_sender != existing_sender:
        return ""
    try:
        existing_dt = datetime.fromisoformat(str(existing.get("timestamp") or "").replace("Z", "+00:00"))
        incoming_dt = datetime.fromisoformat(str(incoming_timestamp).replace("Z", "+00:00"))
        if abs((existing_dt - incoming_dt).total_seconds()) > 10:
            return ""
    except Exception:
        return "same_sender_body"
    return "same_sender_timestamp_body"


def _persist_inbound_to_order_thread(raw_mime: bytes, email_id: str) -> dict:
    try:
        parsed = BytesParser(policy=default).parsebytes(raw_mime)
    except Exception as error:
        return {
            "matched": False,
            "appended": False,
            "order_id": "",
            "order_number": "",
            "message_id": "",
            "reason": f"parse_error:{error}",
        }
    subject = str(parsed.get("Subject") or "").strip()
    sender_name = str(parsed.get("From") or "").strip()
    sender = _extract_email_address(str(parsed.get("From") or ""))
    body_text = _extract_text_body(parsed)
    preview_text = body_text[:1000]
    normalized_body = _normalize_body(body_text)
    message_id = _normalize_message_id(str(parsed.get("Message-ID") or ""))
    timestamp = _parse_message_timestamp(parsed)
    candidates = _extract_order_number_candidates(subject, preview_text, body_text)
    if not normalized_body:
        return {
            "matched": False,
            "appended": False,
            "order_id": "",
            "order_number": "",
            "message_id": "",
            "reason": "empty_body",
        }

    db_path = Path("spaila.db")
    if not db_path.is_file():
        return {
            "matched": False,
            "appended": False,
            "order_id": "",
            "order_number": "",
            "message_id": "",
            "reason": "db_missing",
        }
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        order_id, order_number, match_reason = _find_single_order_match(conn, candidates)
        if not order_id:
            conn.close()
            return {
                "matched": False,
                "appended": False,
                "order_id": "",
                "order_number": "",
                "message_id": "",
                "reason": match_reason,
            }
        cur.execute("SELECT messages FROM orders WHERE id = ?", (order_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return {
                "matched": False,
                "appended": False,
                "order_id": order_id,
                "order_number": order_number,
                "message_id": "",
                "reason": "order_row_missing",
            }
        try:
            messages = json.loads(row[0] or "[]")
        except Exception:
            messages = []
        if not isinstance(messages, list):
            messages = []
        incoming_hash = _subject_timestamp_hash(subject, timestamp)
        for existing in messages:
            if not isinstance(existing, dict):
                continue
            existing_hash = str(existing.get("subject_timestamp_hash") or "").strip().lower()
            if not existing_hash:
                existing_hash = _subject_timestamp_hash(existing.get("subject") or "", existing.get("timestamp") or "")
            if incoming_hash and existing_hash and incoming_hash == existing_hash:
                conn.close()
                return {
                    "matched": True,
                    "appended": False,
                    "order_id": order_id,
                    "order_number": order_number,
                    "message_id": message_id,
                    "reason": "same_subject_timestamp_hash",
                }
            dedupe_reason = _is_duplicate_inbound(
                existing,
                normalized_body,
                sender,
                timestamp,
                str(email_id or "").strip().lower(),
                message_id,
            )
            if dedupe_reason:
                conn.close()
                return {
                    "matched": True,
                    "appended": False,
                    "order_id": order_id,
                    "order_number": order_number,
                    "message_id": message_id,
                    "reason": dedupe_reason,
                }
        stable_id = message_id or f"inbound:{str(email_id or '').strip() or uuid.uuid4()}"
        next_message = {
            "id": stable_id,
            "message_id": message_id,
            "email_id": str(email_id or "").strip(),
            "type": "inbound",
            "direction": "inbound",
            "subject": subject,
            "body": body_text,
            "timestamp": timestamp,
            "sender": sender,
            "sender_name": sender_name,
            "from": sender,
            "source": "inbox",
            "order_number": order_number,
            "subject_timestamp_hash": incoming_hash,
        }
        messages.append(next_message)
        cur.execute("UPDATE orders SET messages = ? WHERE id = ?", (json.dumps(messages), order_id))
        conn.commit()
        conn.close()
        return {
            "matched": True,
            "appended": True,
            "order_id": order_id,
            "order_number": order_number,
            "message_id": message_id or stable_id,
            "reason": "appended",
        }
    except Exception as error:
        return {
            "matched": False,
            "appended": False,
            "order_id": "",
            "order_number": "",
            "message_id": message_id,
            "reason": f"persist_error:{error}",
        }


def fetch_and_store_emails(
    *,
    host: str,
    username: str,
    password: str,
    mailbox: str = "INBOX",
    limit: int = 20,
    port: int = 993,
    use_ssl: bool = True,
) -> Dict[str, object]:
    fetched_messages = fetch_recent_messages(
        host=host,
        username=username,
        password=password,
        mailbox=mailbox,
        limit=limit,
        port=port,
        use_ssl=use_ssl,
    )

    saved = 0
    skipped = 0
    hidden_email_ids = _load_hidden_email_ids()
    processed_refs = _load_processed_order_refs()
    dedup_store = _load_dedup_store()
    now_seen = datetime.now(timezone.utc).isoformat()
    for message in fetched_messages:
        email_id = str(message.email_id or "").strip()
        message_id = _message_id_from_raw(message.raw_mime)
        parsed = None
        subject = ""
        preview_text = ""
        candidates = []
        try:
            parsed = BytesParser(policy=default).parsebytes(message.raw_mime)
            subject = str(parsed.get("Subject") or "").strip()
            body_preview_text = _extract_text_body(parsed)
            preview_text = " ".join(body_preview_text.split())[:220]
            candidates = _extract_order_number_candidates(subject, preview_text, body_preview_text)
        except Exception:
            parsed = None
        ref_keys = _message_ref_keys(message_id, email_id)
        print("[INBOUND_ORDER_MATCH_ATTEMPT]", {
            "email_id": email_id,
            "subject": subject,
            "preview_text": preview_text,
            "candidates": candidates,
        })
        if ref_keys and (ref_keys.intersection(dedup_store) or ref_keys.intersection(processed_refs)):
            # Dedup refs should not skip order-thread evaluation.
            pass
        if email_id in hidden_email_ids or message_id in hidden_email_ids:
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            skipped += 1
            continue

        saved_this_cycle = False
        if not _already_saved(email_id):
            target_path = build_eml_path(email_id)
            if not target_path.exists():
                target_path.write_bytes(message.raw_mime)
                saved += 1
                saved_this_cycle = True
                print("[INBOUND_EMAIL_SAVED]", {
                    "email_id": email_id,
                    "path": str(target_path),
                })
            else:
                skipped += 1
        else:
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            skipped += 1

        for ref_key in ref_keys:
            dedup_store[ref_key] = now_seen
        result = _persist_inbound_to_order_thread(message.raw_mime, email_id)
        print("[INBOUND_MATCH_RESULT]", {
            "email_id": email_id,
            "matched": bool(result.get("matched")),
            "order_number": result.get("order_number") or "",
            "order_id": result.get("order_id") or "",
            "reason": result.get("reason") or "",
        })
        if result.get("matched") and result.get("appended"):
            print("[INBOUND_THREAD_APPENDED]", {
                "email_id": email_id,
                "order_number": result.get("order_number") or "",
                "order_id": result.get("order_id") or "",
                "message_id": result.get("message_id") or "",
            })
        elif result.get("matched"):
            print("[INBOUND_THREAD_ALREADY_EXISTS]", {
                "email_id": email_id,
                "order_number": result.get("order_number") or "",
                "order_id": result.get("order_id") or "",
                "reason": result.get("reason") or "",
            })
        else:
            print("[INBOUND_NO_MATCH]", {
                "email_id": email_id,
                "reason": result.get("reason") or "no_match",
                "saved_this_cycle": saved_this_cycle,
            })

    _save_dedup_store(dedup_store)
    return {"saved": saved, "skipped": skipped}
