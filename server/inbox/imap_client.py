from __future__ import annotations

from dataclasses import dataclass
import imaplib
from typing import List


@dataclass(slots=True)
class InboxMessage:
    email_id: str
    raw_mime: bytes


def _connect(host: str, port: int, use_ssl: bool, timeout: float | None = 30.0):
    if use_ssl:
        try:
            return imaplib.IMAP4_SSL(host, port, timeout=timeout)
        except TypeError:
            return imaplib.IMAP4_SSL(host, port)
    return imaplib.IMAP4(host, port)


def fetch_recent_messages(
    *,
    host: str,
    username: str,
    password: str,
    mailbox: str = "INBOX",
    limit: int = 20,
    port: int = 993,
    use_ssl: bool = True,
) -> List[InboxMessage]:
    host = str(host or "").strip()
    username = str(username or "").strip()
    password = str(password or "")
    mailbox = str(mailbox or "INBOX").strip() or "INBOX"
    max_messages = max(1, min(int(limit or 20), 50))
    imap_port = int(port or 993)

    if not host:
        raise ValueError("IMAP host is required.")
    if not username:
        raise ValueError("IMAP username is required.")
    if not password:
        raise ValueError("IMAP password is required.")

    client = _connect(host, imap_port, use_ssl)
    try:
        client.login(username, password)
        status, _ = client.select(mailbox, readonly=True)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")

        status, data = client.search(None, "ALL")
        if status != "OK":
            raise RuntimeError("Could not search mailbox.")

        email_ids = []
        for chunk in data or []:
            if not chunk:
                continue
            email_ids.extend(part for part in chunk.decode("utf-8", errors="ignore").split() if part)
        selected_ids = email_ids[-max_messages:]

        messages: List[InboxMessage] = []
        for email_id in selected_ids:
            status, fetch_data = client.fetch(email_id, "(RFC822)")
            if status != "OK":
                continue
            raw_mime = b""
            for part in fetch_data or []:
                if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
                    raw_mime = bytes(part[1])
                    break
            if raw_mime:
                messages.append(InboxMessage(email_id=str(email_id), raw_mime=raw_mime))
        return messages
    finally:
        try:
            client.close()
        except Exception:
            pass
        try:
            client.logout()
        except Exception:
            pass
