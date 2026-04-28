from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path
from typing import Any, List

from workspace_paths import ensure_workspace_layout


_WORKSPACE_DIRS = ensure_workspace_layout()
_ATTACHMENT_ROOT = _WORKSPACE_DIRS["root"] / ".spaila_internal" / "attachments"


def _safe_filename(value: str, fallback: str) -> str:
    raw = str(value or "").strip() or fallback
    raw = raw.replace("\\", "/").split("/")[-1]
    raw = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", "_", raw).strip(" ._")
    return raw or fallback


def _message_key(*, email_id: str, message_id: str, raw_mime: bytes) -> str:
    source = str(message_id or "").strip().strip("<>").lower() or str(email_id or "").strip().lower()
    if not source:
        source = hashlib.sha1(raw_mime or b"").hexdigest()
    return hashlib.sha1(source.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _is_attachment_part(part: Message) -> bool:
    filename = part.get_filename()
    disposition = str(part.get_content_disposition() or "").lower()
    content_type = str(part.get_content_type() or "").lower()
    if filename:
        return True
    if disposition == "attachment":
        return True
    if disposition == "inline" and not content_type.startswith("text/"):
        return True
    return False


def extract_and_store_attachments(
    parsed_message: Message,
    *,
    raw_mime: bytes,
    email_id: str,
    message_id: str,
    source_eml_path: str = "",
    timestamp: str = "",
) -> List[dict[str, Any]]:
    """Extract MIME attachment parts into a stable workspace store.

    The original `.eml` remains the source of truth. Extracted files make
    attachment chips easy to open and thumbnail without reparsing the message.
    """
    parts = []
    try:
        walker = parsed_message.walk() if parsed_message.is_multipart() else [parsed_message]
        for part in walker:
            if part.get_content_maintype() == "multipart":
                continue
            if _is_attachment_part(part):
                parts.append(part)
    except Exception:
        parts = []

    if not parts:
        return []

    key = _message_key(email_id=email_id, message_id=message_id, raw_mime=raw_mime)
    target_dir = _ATTACHMENT_ROOT / key
    target_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        try:
            import subprocess

            subprocess.run(["attrib", "+h", str(_ATTACHMENT_ROOT.parent)], check=False, capture_output=True)
        except Exception:
            pass

    print(
        "[ATTACHMENT_INGEST] "
        + json.dumps({
            "email_id": email_id,
            "message_id": message_id,
            "count": len(parts),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )

    stored: list[dict[str, Any]] = []
    used_names: set[str] = set()
    now = datetime.now(timezone.utc).isoformat()
    for index, part in enumerate(parts):
        filename = _safe_filename(part.get_filename() or "", f"attachment-{index + 1}")
        stem = Path(filename).stem or f"attachment-{index + 1}"
        suffix = Path(filename).suffix
        candidate = filename
        duplicate_index = 2
        while candidate.lower() in used_names:
            candidate = f"{stem}-{duplicate_index}{suffix}"
            duplicate_index += 1
        used_names.add(candidate.lower())

        try:
            payload = part.get_payload(decode=True) or b""
        except Exception:
            payload = b""
        file_path = target_dir / candidate
        file_path.write_bytes(payload)
        content_type = str(part.get_content_type() or "").lower()
        if not content_type or content_type == "application/octet-stream":
            content_type = mimetypes.guess_type(candidate)[0] or content_type or "application/octet-stream"
        metadata = {
            "file": candidate,
            "filename": candidate,
            "name": candidate,
            "path": str(file_path),
            "mime_type": content_type,
            "type": content_type,
            "size": len(payload),
            "source": "inbound_eml",
            "direction": "inbound",
            "email_id": str(email_id or "").strip(),
            "message_id": str(message_id or "").strip(),
            "attachment_index": index,
            "attachmentIndex": index,
            "sourcePath": source_eml_path,
            "timestamp": timestamp or now,
        }
        stored.append(metadata)
        print(
            "[ATTACHMENT_STORE] "
            + json.dumps({
                "email_id": email_id,
                "message_id": message_id,
                "file": candidate,
                "path": str(file_path),
                "mime_type": content_type,
                "size": len(payload),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )

    return stored
