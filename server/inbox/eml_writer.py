from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from workspace_paths import ensure_workspace_layout


_WORKSPACE_DIRS = ensure_workspace_layout()
_INBOX_DIR = _WORKSPACE_DIRS["InboxModule"]


def _to_bytes(raw_mime: bytes | str) -> bytes:
    if isinstance(raw_mime, bytes):
        return raw_mime
    return str(raw_mime or "").encode("utf-8", errors="surrogateescape")


def build_eml_path(email_id: str, target_dir: Path | None = None) -> Path:
    destination_dir = Path(target_dir) if target_dir else _INBOX_DIR
    destination_dir.mkdir(parents=True, exist_ok=True)
    safe_email_id = "".join(ch for ch in str(email_id or "").strip() if ch.isalnum()) or "unknown"
    timestamp = str(int(datetime.now(timezone.utc).timestamp()))
    return destination_dir / f"{timestamp}_{safe_email_id}.eml"


def write_eml_file(raw_mime: bytes | str, email_id: str, target_dir: Path | None = None) -> Path:
    target_path = build_eml_path(email_id, target_dir)
    target_path.write_bytes(_to_bytes(raw_mime))
    return target_path
