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
    try:
        return imaplib.IMAP4(host, port, timeout=timeout)
    except TypeError:
        return imaplib.IMAP4(host, port)


def check_imap_connection(
    *,
    host: str,
    username: str,
    password: str,
    mailbox: str = "INBOX",
    port: int = 993,
    use_ssl: bool = True,
    timeout: float = 2.5,
) -> bool:
    host = str(host or "").strip()
    username = str(username or "").strip()
    password = str(password or "")
    mailbox = str(mailbox or "INBOX").strip() or "INBOX"
    imap_port = int(port or 993)

    if not host or not username or not password:
        return False

    client = None
    selected = False
    try:
        client = _connect(host, imap_port, use_ssl, timeout=timeout)
        status, _ = client.login(username, password)
        if status != "OK":
            return False
        status, _ = client.select(mailbox, readonly=True)
        selected = status == "OK"
        if not selected:
            status, _ = client.noop()
            return status == "OK"
        status, _ = client.noop()
        return status == "OK"
    except Exception:
        return False
    finally:
        if client is not None:
            if selected:
                try:
                    client.close()
                except Exception:
                    pass
            try:
                client.logout()
            except Exception:
                pass


def fetch_recent_messages(
    *,
    host: str,
    username: str,
    password: str,
    mailbox: str = "INBOX",
    limit: int = 20,
    port: int = 993,
    use_ssl: bool = True,
    since_uid: int | None = None,
    strict: bool = False,
) -> List[InboxMessage]:
    host = str(host or "").strip()
    username = str(username or "").strip()
    password = str(password or "")
    mailbox = str(mailbox or "INBOX").strip() or "INBOX"
    max_messages = max(1, min(int(limit or 20), 100))
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

        if since_uid is not None and int(since_uid or 0) > 0:
            status, data = client.uid("search", None, "UID", f"{int(since_uid) + 1}:*")
        else:
            status, data = client.uid("search", None, "ALL")
        if status != "OK":
            raise RuntimeError("Could not search mailbox.")

        email_ids = []
        for chunk in data or []:
            if not chunk:
                continue
            email_ids.extend(part for part in chunk.decode("utf-8", errors="ignore").split() if part)
        selected_ids = email_ids if since_uid is not None else email_ids[-max_messages:]

        messages: List[InboxMessage] = []
        for email_id in selected_ids:
            status, fetch_data = client.uid("fetch", email_id, "(RFC822)")
            if status != "OK":
                if strict:
                    raise RuntimeError(f"Could not fetch mailbox UID {email_id}.")
                continue
            raw_mime = b""
            for part in fetch_data or []:
                if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
                    raw_mime = bytes(part[1])
                    break
            if raw_mime:
                messages.append(InboxMessage(email_id=str(email_id), raw_mime=raw_mime))
            elif strict:
                raise RuntimeError(f"Mailbox UID {email_id} returned no message body.")
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


def list_message_uids(
    *,
    host: str,
    username: str,
    password: str,
    mailbox: str = "INBOX",
    port: int = 993,
    use_ssl: bool = True,
) -> set[str]:
    host = str(host or "").strip()
    username = str(username or "").strip()
    password = str(password or "")
    mailbox = str(mailbox or "INBOX").strip() or "INBOX"
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
        status, data = client.uid("search", None, "ALL")
        if status != "OK":
            raise RuntimeError("Could not search mailbox.")

        uids: set[str] = set()
        for chunk in data or []:
            if not chunk:
                continue
            uids.update(part for part in chunk.decode("utf-8", errors="ignore").split() if part)
        return uids
    finally:
        try:
            client.close()
        except Exception:
            pass
        try:
            client.logout()
        except Exception:
            pass


def delete_message(
    *,
    host: str,
    username: str,
    password: str,
    email_id: str,
    mailbox: str = "INBOX",
    port: int = 993,
    use_ssl: bool = True,
    timeout: float = 2.5,
) -> bool:
    host = str(host or "").strip()
    username = str(username or "").strip()
    password = str(password or "")
    email_id = str(email_id or "").strip()
    mailbox = str(mailbox or "INBOX").strip() or "INBOX"
    imap_port = int(port or 993)

    if not host:
        raise ValueError("IMAP host is required.")
    if not username:
        raise ValueError("IMAP username is required.")
    if not password:
        raise ValueError("IMAP password is required.")
    if not email_id or email_id.startswith("local:"):
        raise ValueError("This email does not have an IMAP identifier.")

    client = _connect(host, imap_port, use_ssl, timeout=timeout)
    selected = False
    try:
        client.login(username, password)
        status, _ = client.select(mailbox, readonly=False)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")
        selected = True

        target_uid = email_id
        if not email_id.isdigit():
            search_value = email_id if email_id.startswith("<") else f"<{email_id}>"
            status, data = client.uid("search", None, "HEADER", "Message-ID", search_value)
            if status != "OK":
                raise RuntimeError("Could not search mailbox for Message-ID.")
            target_uid = ""
            for chunk in data or []:
                if not chunk:
                    continue
                target_uid = chunk.decode("utf-8", errors="ignore").split()[0]
                break
            if not target_uid:
                raise RuntimeError("Email was not found in the mailbox.")

        status, _ = client.uid("store", target_uid, "+FLAGS", r"(\Deleted)")
        if status != "OK":
            raise RuntimeError("Could not mark email as deleted.")
        status, _ = client.expunge()
        if status != "OK":
            raise RuntimeError("Could not expunge deleted email.")
        return True
    finally:
        if selected:
            try:
                client.close()
            except Exception:
                pass
        try:
            client.logout()
        except Exception:
            pass
