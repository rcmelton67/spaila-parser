from __future__ import annotations

from typing import Dict

from workspace_paths import ensure_workspace_layout

from .eml_writer import build_eml_path
from .imap_client import fetch_recent_messages


_WORKSPACE_DIRS = ensure_workspace_layout()
_INBOX_DIR = _WORKSPACE_DIRS["InboxModule"]


def _already_saved(email_id: str) -> bool:
    safe_email_id = "".join(ch for ch in str(email_id or "").strip() if ch.isalnum()) or "unknown"
    return any(_INBOX_DIR.glob(f"*_{safe_email_id}.eml"))


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
    for message in fetched_messages:
        email_id = str(message.email_id or "").strip()
        if _already_saved(email_id):
            continue

        target_path = build_eml_path(email_id)
        if target_path.exists():
            continue
        target_path.write_bytes(message.raw_mime)
        saved += 1

    return {"saved": saved}
