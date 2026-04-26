from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from email.parser import BytesParser
from email.policy import default
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
        ref_keys = _message_ref_keys(message_id, email_id)
        if ref_keys and (ref_keys.intersection(dedup_store) or ref_keys.intersection(processed_refs)):
            skipped += 1
            continue
        if email_id in hidden_email_ids or message_id in hidden_email_ids:
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            skipped += 1
            continue
        if _already_saved(email_id):
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            skipped += 1
            continue

        target_path = build_eml_path(email_id)
        if target_path.exists():
            for ref_key in ref_keys:
                dedup_store[ref_key] = now_seen
            skipped += 1
            continue
        for ref_key in ref_keys:
            dedup_store[ref_key] = now_seen
        target_path.write_bytes(message.raw_mime)
        saved += 1

    _save_dedup_store(dedup_store)
    return {"saved": saved, "skipped": skipped}
