from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import re
import uuid
import hashlib
from difflib import SequenceMatcher
from email.parser import BytesParser
from email.policy import default
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict

from workspace_paths import ensure_workspace_layout

from .eml_writer import build_eml_path
from .imap_client import fetch_recent_messages, list_message_uids
from .attachments import extract_and_store_attachments


_WORKSPACE_DIRS = ensure_workspace_layout()
_INBOX_DIR = _WORKSPACE_DIRS["InboxModule"]
_HIDDEN_EMAILS_PATH = _WORKSPACE_DIRS["root"] / "hidden_emails.json"
_INTERNAL_DIR = _WORKSPACE_DIRS["root"] / ".spaila_internal"
_DEDUP_STORE_PATH = _INTERNAL_DIR / "dedup_store.json"
_FETCH_STATE_PATH = _INTERNAL_DIR / "inbox_fetch_state.json"
_SOURCE_STATE_PATH = _INTERNAL_DIR / "inbox_source_state.json"
_DEDUP_TTL = timedelta(days=14)
_DEDUP_MAX_ENTRIES = 10_000
_ORDER_NUMBER_PATTERN = re.compile(r"\b\d{3,12}\b")
_ORDER_CONTEXT_PATTERN = re.compile(r"\border\s*#?\s*([A-Z0-9-]{3,32})\b", re.IGNORECASE)
_REPLY_PREFIX_PATTERN = re.compile(r"^\s*((re|fw|fwd)\s*:\s*)+", re.IGNORECASE)
_ORDER_MATCH_MIN_CONFIDENCE = 70


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


def _load_fetch_state() -> dict[str, int | str]:
    try:
        data = json.loads(_FETCH_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    last_seen_uid = 0
    try:
        last_seen_uid = max(0, int(data.get("last_seen_uid") or 0))
    except Exception:
        last_seen_uid = 0
    return {"last_seen_uid": last_seen_uid}


def _save_fetch_state(*, last_seen_uid: int) -> None:
    _INTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        try:
            subprocess.run(["attrib", "+h", str(_INTERNAL_DIR)], check=False, capture_output=True)
        except Exception:
            pass
    _FETCH_STATE_PATH.write_text(json.dumps({
        "last_seen_uid": max(0, int(last_seen_uid or 0)),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2), encoding="utf-8")


def _load_source_state() -> dict[str, bool]:
    try:
        data = json.loads(_SOURCE_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    raw_uids = data.get("uids") if isinstance(data, dict) else {}
    if not isinstance(raw_uids, dict):
        raw_uids = {}
    return {str(uid): bool(value) for uid, value in raw_uids.items() if str(uid).strip()}


def _save_source_state(uid_state: dict[str, bool]) -> None:
    _INTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        try:
            subprocess.run(["attrib", "+h", str(_INTERNAL_DIR)], check=False, capture_output=True)
        except Exception:
            pass
    _SOURCE_STATE_PATH.write_text(json.dumps({
        "uids": {str(uid): bool(value) for uid, value in uid_state.items() if str(uid).strip()},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2), encoding="utf-8")


def mark_source_deleted(uid: str, deleted: bool) -> None:
    uid = str(uid or "").strip()
    if not uid:
        return
    state = _load_source_state()
    state[uid] = bool(deleted)
    _save_source_state(state)
    print("[SOURCE_DELETED_UPDATE]", {
        "uid": uid,
        "source_deleted": bool(deleted),
    })


def _reconcile_source_deleted(server_uids: set[str]) -> dict[str, int]:
    existing_state = _load_source_state()
    next_state: dict[str, bool] = {}
    changed = 0
    missing = 0
    restored = 0
    for eml_path in _INBOX_DIR.glob("*.eml"):
        uid = _saved_uid_from_path(str(eml_path))
        if not uid:
            continue
        source_deleted = uid not in server_uids
        next_state[uid] = source_deleted
        if source_deleted:
            missing += 1
            if existing_state.get(uid) is not True:
                print("[PROVIDER_MISSING_MESSAGE]", {
                    "uid": uid,
                    "path": str(eml_path),
                })
                print("[SOURCE_DELETED_PROVIDER]", {
                    "uid": uid,
                    "source_deleted": True,
                })
        elif existing_state.get(uid) is True:
            restored += 1
        if existing_state.get(uid) != source_deleted:
            changed += 1
    _save_source_state(next_state)
    print("[PROVIDER_RECONCILE]", {
        "server_uid_count": len(server_uids),
        "local_uid_count": len(next_state),
        "missing_count": missing,
        "restored_count": restored,
        "changed_count": changed,
    })
    if changed:
        print("[INBOX SOURCE] source_deleted changed count=", changed)
    return {
        "server_uid_count": len(server_uids),
        "local_uid_count": len(next_state),
        "missing_count": missing,
        "restored_count": restored,
        "changed_count": changed,
    }


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
        for match in _ORDER_CONTEXT_PATTERN.finditer(source):
            number = match.group(1).strip()
            key = _normalize_order_token(number)
            if not key or key in seen:
                continue
            seen.add(key)
            found.append(number)
        for match in _ORDER_NUMBER_PATTERN.finditer(source):
            number = match.group(0).strip()
            key = _normalize_order_token(number)
            if not key or key in seen:
                continue
            seen.add(key)
            found.append(number)
    return found


def _normalize_order_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _extract_email_address(value: str) -> str:
    source = str(value or "").strip()
    match = re.search(r"<([^<>\s]+@[^<>\s]+)>", source)
    if match:
        return match.group(1).strip().lower()
    match = re.search(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", source, re.IGNORECASE)
    return (match.group(0).strip().lower() if match else source.lower())


def _normalize_body(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def _saved_eml_path_for_email_id(email_id: str) -> str:
    safe_email_id = "".join(ch for ch in str(email_id or "").strip() if ch.isalnum()) or "unknown"
    try:
        matches = sorted(_INBOX_DIR.glob(f"*_{safe_email_id}.eml"), key=lambda item: item.stat().st_mtime, reverse=True)
    except Exception:
        matches = []
    return str(matches[0]) if matches else ""


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


def _normalize_subject_for_match(value: str) -> str:
    subject = _REPLY_PREFIX_PATTERN.sub("", str(value or "")).strip().lower()
    subject = re.sub(r"\[[^\]]+\]", " ", subject)
    subject = re.sub(r"\s+", " ", subject)
    return subject.strip()


def _split_header_refs(value: str) -> set[str]:
    refs: set[str] = set()
    for token in re.findall(r"<([^<>]+)>", str(value or "")):
        normalized = _normalize_message_id(token)
        if normalized:
            refs.add(normalized)
    normalized_whole = _normalize_message_id(value)
    if normalized_whole and " " not in normalized_whole:
        refs.add(normalized_whole)
    return refs


def _parse_iso_datetime(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _name_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
        if len(token) >= 3
    }


def _load_order_header_refs(path_value: str) -> tuple[set[str], str]:
    try:
        path = Path(str(path_value or ""))
        if not path.is_file():
            return set(), ""
        headers = BytesParser(policy=default).parsebytes(path.read_bytes(), headersonly=True)
        refs = _split_header_refs(str(headers.get("Message-ID") or ""))
        refs.update(_split_header_refs(str(headers.get("In-Reply-To") or "")))
        refs.update(_split_header_refs(str(headers.get("References") or "")))
        return refs, str(headers.get("Subject") or "").strip()
    except Exception:
        return set(), ""


def _load_active_order_candidates(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, order_number, buyer_name, buyer_email, messages,
               source_eml_path, eml_path, created_at, order_date, last_activity_at
        FROM orders
        WHERE COALESCE(status, '') != 'deleted'
          AND COALESCE(status, '') != 'archived'
          AND COALESCE(status, '') != 'archiving'
        """
    )
    rows = cur.fetchall()
    orders: list[dict] = []
    for row in rows:
        try:
            messages = json.loads(row[4] or "[]")
        except Exception:
            messages = []
        if not isinstance(messages, list):
            messages = []
        header_refs: set[str] = set()
        subjects: set[str] = set()
        for eml_path in [row[5], row[6]]:
            refs, source_subject = _load_order_header_refs(str(eml_path or ""))
            header_refs.update(refs)
            if source_subject:
                subjects.add(source_subject)
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            header_refs.update(_split_header_refs(str(msg.get("message_id") or msg.get("id") or "")))
            header_refs.update(_split_header_refs(str(msg.get("in_reply_to") or "")))
            header_refs.update(_split_header_refs(str(msg.get("references") or "")))
            msg_subject = str(msg.get("subject") or "").strip()
            if msg_subject:
                subjects.add(msg_subject)
        orders.append({
            "id": str(row[0] or "").strip(),
            "order_number": str(row[1] or "").strip(),
            "buyer_name": str(row[2] or "").strip(),
            "buyer_email": _extract_email_address(str(row[3] or "")),
            "messages": messages,
            "header_refs": header_refs,
            "subjects": subjects,
            "created_at": str(row[7] or "").strip(),
            "order_date": str(row[8] or "").strip(),
            "last_activity_at": str(row[9] or "").strip(),
        })
    return orders


def _score_order_match(
    order: dict,
    *,
    order_candidates: list[str],
    sender_email: str,
    sender_name: str,
    subject: str,
    header_refs: set[str],
    timestamp: str,
) -> dict:
    score = 0
    reasons: list[str] = []
    order_token = _normalize_order_token(order.get("order_number") or "")
    candidate_tokens = {_normalize_order_token(value) for value in order_candidates if _normalize_order_token(value)}
    if order_token and order_token in candidate_tokens:
        score += 100
        reasons.append("order_number")

    if sender_email and order.get("buyer_email") and sender_email == order.get("buyer_email"):
        score += 80
        reasons.append("buyer_email")

    if header_refs and header_refs.intersection(order.get("header_refs") or set()):
        score += 90
        reasons.append("thread_header")

    incoming_subject = _normalize_subject_for_match(subject)
    best_subject_ratio = 0.0
    for known_subject in order.get("subjects") or set():
        normalized_known = _normalize_subject_for_match(known_subject)
        if not incoming_subject or not normalized_known:
            continue
        if incoming_subject == normalized_known:
            best_subject_ratio = 1.0
            break
        best_subject_ratio = max(best_subject_ratio, SequenceMatcher(None, incoming_subject, normalized_known).ratio())
    if best_subject_ratio >= 0.98:
        score += 55
        reasons.append("subject_continuity")
    elif best_subject_ratio >= 0.82:
        score += 40
        reasons.append("subject_similarity")

    incoming_tokens = _name_tokens(sender_name)
    buyer_tokens = _name_tokens(order.get("buyer_name") or "")
    if incoming_tokens and buyer_tokens and incoming_tokens.intersection(buyer_tokens):
        score += 20
        reasons.append("buyer_name")

    incoming_dt = _parse_iso_datetime(timestamp)
    candidate_dt = (
        _parse_iso_datetime(order.get("last_activity_at") or "")
        or _parse_iso_datetime(order.get("created_at") or "")
        or _parse_iso_datetime(order.get("order_date") or "")
    )
    if incoming_dt and candidate_dt:
        age_days = abs((incoming_dt - candidate_dt).total_seconds()) / 86400
        if age_days <= 30:
            score += 15
            reasons.append("recent_order")
        elif age_days <= 90:
            score += 8
            reasons.append("recent_order")

    return {
        "order": order,
        "confidence": min(score, 100),
        "score": score,
        "reason": "+".join(reasons) if reasons else "no_signal",
    }


def _find_best_order_match(
    conn: sqlite3.Connection,
    *,
    order_candidates: list[str],
    sender_email: str,
    sender_name: str,
    subject: str,
    header_refs: set[str],
    timestamp: str,
) -> tuple[str, str, str, int]:
    scored = [
        _score_order_match(
            order,
            order_candidates=order_candidates,
            sender_email=sender_email,
            sender_name=sender_name,
            subject=subject,
            header_refs=header_refs,
            timestamp=timestamp,
        )
        for order in _load_active_order_candidates(conn)
    ]
    scored = [item for item in scored if item["score"] > 0]
    if not scored:
        return "", "", "no_order_match", 0
    scored.sort(key=lambda item: (item["score"], _parse_iso_datetime(item["order"].get("last_activity_at") or item["order"].get("created_at") or "") or datetime.min.replace(tzinfo=timezone.utc)), reverse=True)
    best = scored[0]
    second = scored[1] if len(scored) > 1 else None
    if best["confidence"] < _ORDER_MATCH_MIN_CONFIDENCE:
        return "", "", f"low_confidence:{best['reason']}", int(best["confidence"])
    if second and best["score"] - second["score"] < 8 and "order_number" not in best["reason"] and "thread_header" not in best["reason"]:
        return "", "", f"ambiguous_order_match:{best['reason']}", int(best["confidence"])
    order = best["order"]
    return str(order.get("id") or ""), str(order.get("order_number") or ""), str(best["reason"]), int(best["confidence"])


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
    header_refs = _split_header_refs(message_id)
    header_refs.update(_split_header_refs(str(parsed.get("In-Reply-To") or "")))
    header_refs.update(_split_header_refs(str(parsed.get("References") or "")))
    timestamp = _parse_message_timestamp(parsed)
    source_eml_path = _saved_eml_path_for_email_id(email_id)
    attachments = extract_and_store_attachments(
        parsed,
        raw_mime=raw_mime,
        email_id=email_id,
        message_id=message_id,
        source_eml_path=source_eml_path,
        timestamp=timestamp,
    )
    candidates = _extract_order_number_candidates(subject, preview_text, body_text)
    print("[INGEST]", {
        "email_id": email_id,
        "subject": subject,
        "order_candidates": candidates,
    })
    if not normalized_body and not attachments and not candidates:
        return {
            "matched": False,
            "appended": False,
            "order_id": "",
            "order_number": "",
            "message_id": "",
            "reason": "empty_body",
        }
    if not normalized_body and attachments:
        attachment_names = ", ".join(str(item.get("name") or item.get("file") or "attachment") for item in attachments[:3])
        body_text = f"[Attachment email: {attachment_names or len(attachments)} attachment(s)]"
        preview_text = body_text[:1000]
        normalized_body = _normalize_body(body_text)

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
        order_id, order_number, match_reason, match_confidence = _find_best_order_match(
            conn,
            order_candidates=candidates,
            sender_email=sender,
            sender_name=sender_name,
            subject=subject,
            header_refs=header_refs,
            timestamp=timestamp,
        )
        print("[ORDER MATCH]", {
            "source": "email",
            "matched_order": order_number or "",
            "order_id": order_id or "",
            "reason": match_reason,
            "confidence": match_confidence,
            "email_id": email_id,
        })
        if not order_id:
            print("[ROUTE]", {
                "email_id": email_id,
                "decision": "no_match",
                "reason": match_reason,
                "candidates": candidates,
                "confidence": match_confidence,
            })
            conn.close()
            return {
                "matched": False,
                "appended": False,
                "order_id": "",
                "order_number": "",
                "message_id": "",
                "reason": match_reason,
                "confidence": match_confidence,
            }
        cur.execute("SELECT messages, buyer_name FROM orders WHERE id = ?", (order_id,))
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
        buyer_name = str(row[1] or "")
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
                print("[ROUTE]", {
                    "email_id": email_id,
                    "decision": "duplicate_skipped",
                    "order_number": order_number,
                    "reason": "same_subject_timestamp_hash",
                })
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
                print("[ROUTE]", {
                    "email_id": email_id,
                    "decision": "duplicate_skipped",
                    "order_number": order_number,
                    "reason": dedupe_reason,
                })
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
            # inbox_type distinguishes customer replies (order_update) from the original
            # order-creation email (new_order).  The frontend uses this to keep order_update
            # messages visible in the inbox instead of filtering them out as "processed".
            "inbox_type": "order_update",
            "linked_order_id": order_id,
            "subject": subject,
            "body": body_text,
            "attachments": attachments,
            "timestamp": timestamp,
            "sender": sender,
            "sender_name": sender_name,
            "from": sender,
            "source": "inbox",
            "order_number": order_number,
            "match_reason": match_reason,
            "match_confidence": match_confidence,
            "in_reply_to": str(parsed.get("In-Reply-To") or "").strip(),
            "references": str(parsed.get("References") or "").strip(),
            "subject_timestamp_hash": incoming_hash,
        }
        messages.append(next_message)
        cur.execute("UPDATE orders SET messages = ? WHERE id = ?", (json.dumps(messages), order_id))
        # Create inbox event for this reply so it surfaces in the activity feed
        event_id = str(uuid.uuid4())
        event_now = datetime.now(timezone.utc).isoformat()
        cur.execute(
            """
            INSERT INTO inbox_events
                (id, type, order_id, order_number, buyer_name, preview, timestamp, unread, created_at)
            VALUES (?, 'order_update', ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                event_id,
                order_id,
                order_number or "",
                buyer_name,
                (body_text[:140].strip() or f"{len(attachments)} attachment(s)"),
                timestamp or event_now,
                event_now,
            ),
        )
        conn.commit()
        conn.close()
        print("[ROUTE]", {
            "email_id": email_id,
            "decision": "attach_to_order",
            "order_number": order_number,
            "order_id": order_id,
            "message_id": message_id or stable_id,
            "reason": match_reason,
            "confidence": match_confidence,
        })
        return {
            "matched": True,
            "appended": True,
            "order_id": order_id,
            "order_number": order_number,
            "message_id": message_id or stable_id,
            "reason": match_reason,
            "confidence": match_confidence,
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
    resync: bool = False,
) -> Dict[str, object]:
    print("[INBOX FETCH] starting")
    fetch_state = _load_fetch_state()
    last_seen_uid = int(fetch_state.get("last_seen_uid") or 0)
    try:
        server_uids = list_message_uids(
            host=host,
            username=username,
            password=password,
            mailbox=mailbox,
            port=port,
            use_ssl=use_ssl,
        )
        fetched_messages = fetch_recent_messages(
            host=host,
            username=username,
            password=password,
            mailbox=mailbox,
            limit=limit,
            port=port,
            use_ssl=use_ssl,
            since_uid=None if resync or last_seen_uid <= 0 else last_seen_uid,
            strict=not resync,
        )
    except Exception:
        print("[INBOX FETCH] failed")
        raise

    saved = 0
    skipped = 0
    max_seen_uid = last_seen_uid
    hidden_email_ids = _load_hidden_email_ids()
    processed_refs = _load_processed_order_refs()
    dedup_store = _load_dedup_store()
    now_seen = datetime.now(timezone.utc).isoformat()
    for message in fetched_messages:
        email_id = str(message.email_id or "").strip()
        try:
            max_seen_uid = max(max_seen_uid, int(email_id))
        except Exception:
            pass
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
        is_duplicate_message = bool(ref_keys and ref_keys.intersection(dedup_store))
        if is_duplicate_message:
            skipped += 1
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            continue
        if ref_keys and ref_keys.intersection(processed_refs):
            # Processed refs should not skip order-thread evaluation for customer replies.
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
    reconcile_result = _reconcile_source_deleted(server_uids)
    if not resync:
        _save_fetch_state(last_seen_uid=max_seen_uid)
    print("[INBOX FETCH] success count=", saved)
    return {
        "saved": saved,
        "skipped": skipped,
        "fetched": len(fetched_messages),
        "last_seen_uid": max_seen_uid,
        "source_deleted_missing": reconcile_result.get("missing_count", 0),
        "source_deleted_changed": reconcile_result.get("changed_count", 0),
    }
