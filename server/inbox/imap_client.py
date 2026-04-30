from __future__ import annotations

from dataclasses import dataclass
import imaplib
from typing import List


@dataclass(slots=True)
class InboxMessage:
    email_id: str
    raw_mime: bytes


_GMAIL_TRASH_FOLDERS = (
    "[Gmail]/Trash",
    "[Google Mail]/Trash",
    "[Gmail]/Bin",
    "[Google Mail]/Bin",
)
_OUTLOOK_TRASH_FOLDERS = (
    "Deleted Items",
    "Deleted",
)
_GENERIC_TRASH_FOLDERS = (
    "Trash",
    "Bin",
    "Deleted Messages",
    "Deleted Items",
    "INBOX.Trash",
    "INBOX/Trash",
)


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


def _quote_mailbox(mailbox: str) -> str:
    mailbox = str(mailbox or "").strip()
    if not mailbox:
        return '""'
    if mailbox.startswith('"') and mailbox.endswith('"'):
        return mailbox
    if any(ch.isspace() for ch in mailbox) or any(ch in mailbox for ch in '()[]{}"\\'):
        return '"' + mailbox.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return mailbox


def _select_mailbox(client, mailbox: str, *, readonly: bool = False):
    status, data = client.select(mailbox, readonly=readonly)
    if status == "OK":
        return status, data
    quoted = _quote_mailbox(mailbox)
    if quoted != mailbox:
        return client.select(quoted, readonly=readonly)
    return status, data


def _decode_mailbox_list_name(row) -> str:
    if isinstance(row, bytes):
        text = row.decode("utf-8", errors="ignore")
    else:
        text = str(row or "")
    text = text.strip()
    if not text:
        return ""
    flags_end = text.find(")")
    remainder = text[flags_end + 1:].strip() if flags_end >= 0 else text
    if not remainder:
        return ""
    if remainder.startswith('"'):
        delimiter_end = remainder.find('"', 1)
        if delimiter_end >= 0:
            remainder = remainder[delimiter_end + 1:].strip()
    else:
        parts = remainder.split(None, 1)
        remainder = parts[1].strip() if len(parts) > 1 else ""
    if remainder.upper().startswith("NIL "):
        remainder = remainder[4:].strip()
    if remainder.startswith('"') and remainder.endswith('"') and len(remainder) >= 2:
        return remainder[1:-1].replace(r"\"", '"').replace(r"\\", "\\").strip()
    return remainder.strip().strip('"')


def _decode_mailbox_list_flags(row) -> str:
    if isinstance(row, bytes):
        text = row.decode("utf-8", errors="ignore")
    else:
        text = str(row or "")
    start = text.find("(")
    end = text.find(")", start + 1)
    if start >= 0 and end > start:
        return text[start + 1:end].casefold()
    return ""


def _list_mailboxes(client) -> list[tuple[str, str]]:
    status, data = client.list()
    if status != "OK":
        return []
    mailboxes: list[tuple[str, str]] = []
    for row in data or []:
        name = _decode_mailbox_list_name(row)
        if name:
            mailboxes.append((name, _decode_mailbox_list_flags(row)))
    return mailboxes


def _trash_folder_candidates(host: str) -> tuple[str, ...]:
    host_lower = str(host or "").lower()
    if "gmail" in host_lower or "googlemail" in host_lower:
        preferred = _GMAIL_TRASH_FOLDERS
    elif "outlook" in host_lower or "office365" in host_lower or "hotmail" in host_lower or "live.com" in host_lower:
        preferred = _OUTLOOK_TRASH_FOLDERS
    else:
        preferred = ()
    seen: set[str] = set()
    candidates: list[str] = []
    for name in (*preferred, *_GMAIL_TRASH_FOLDERS, *_OUTLOOK_TRASH_FOLDERS, *_GENERIC_TRASH_FOLDERS):
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            candidates.append(name)
    return tuple(candidates)


def _resolve_trash_mailbox(client, *, host: str) -> str:
    available = _list_mailboxes(client)
    for name, flags in available:
        if "\\trash" in flags or "\\deleted" in flags:
            return name
    by_lower = {name.casefold(): name for name, _flags in available}
    for candidate in _trash_folder_candidates(host):
        match = by_lower.get(candidate.casefold())
        if match:
            return match
    for name, _flags in available:
        lowered = name.casefold()
        if lowered.endswith("/trash") or lowered.endswith(".trash") or "trash" in lowered:
            return name
        if "deleted items" in lowered or "deleted messages" in lowered or lowered.endswith("/bin") or lowered.endswith(".bin"):
            return name
    return ""


def _find_target_uid(client, email_id: str) -> str:
    target_uid = str(email_id or "").strip()
    if target_uid.isdigit():
        return target_uid
    search_value = target_uid if target_uid.startswith("<") else f"<{target_uid}>"
    status, data = client.uid("search", None, "HEADER", "Message-ID", search_value)
    if status != "OK":
        raise RuntimeError("Could not search mailbox for Message-ID.")
    for chunk in data or []:
        if not chunk:
            continue
        found = chunk.decode("utf-8", errors="ignore").split()
        if found:
            return found[0]
    raise RuntimeError("Email was not found in the mailbox.")


def _mark_deleted_and_expunge(client, target_uid: str) -> None:
    status, _ = client.uid("store", target_uid, "+FLAGS", r"(\Deleted)")
    if status != "OK":
        raise RuntimeError("Could not mark email as deleted.")
    status, _ = client.expunge()
    if status != "OK":
        raise RuntimeError("Could not expunge deleted email.")

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
        status, _ = _select_mailbox(client, mailbox, readonly=True)
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
        status, _ = _select_mailbox(client, mailbox, readonly=True)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")

        if since_uid is not None and int(since_uid or 0) > 0:
            status, data = client.uid("search", None, "UID", f"{int(since_uid) + 1}:*", "UNDELETED")
        else:
            status, data = client.uid("search", None, "UNDELETED")
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
        status, _ = _select_mailbox(client, mailbox, readonly=True)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")
        status, data = client.uid("search", None, "UNDELETED")
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
        status, _ = _select_mailbox(client, mailbox, readonly=False)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")
        selected = True

        target_uid = _find_target_uid(client, email_id)
        _mark_deleted_and_expunge(client, target_uid)
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


def move_message_to_trash(
    *,
    host: str,
    username: str,
    password: str,
    email_id: str,
    mailbox: str = "INBOX",
    port: int = 993,
    use_ssl: bool = True,
    timeout: float = 2.5,
) -> dict:
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
        trash_mailbox = _resolve_trash_mailbox(client, host=host)
        status, _ = _select_mailbox(client, mailbox, readonly=False)
        if status != "OK":
            raise RuntimeError(f"Could not open mailbox: {mailbox}")
        selected = True

        target_uid = _find_target_uid(client, email_id)
        if not trash_mailbox:
            print("[PROVIDER_HARD_DELETE_BLOCKED]", {"email_id": email_id, "reason": "trash_folder_unavailable"})
            raise RuntimeError("Provider Trash folder unavailable.")

        quoted_trash = _quote_mailbox(trash_mailbox)
        print("[TRASH_PROVIDER_FOLDER]", {"email_id": email_id, "trash_mailbox": trash_mailbox})
        status, _ = client.uid("MOVE", target_uid, quoted_trash)
        if status == "OK":
            return {"status": "ok", "method": "move", "trash_mailbox": trash_mailbox}

        status, _ = client.uid("COPY", target_uid, quoted_trash)
        if status != "OK":
            raise RuntimeError(f"Could not copy email to provider Trash folder: {trash_mailbox}")
        _mark_deleted_and_expunge(client, target_uid)
        return {"status": "ok", "method": "copy_expunge_source", "trash_mailbox": trash_mailbox}
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
