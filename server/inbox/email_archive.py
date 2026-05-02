from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from typing import Any

from workspace_paths import get_workspace_dirs


_WORKSPACE_DIRS = get_workspace_dirs()
_INTERNAL_DIR = _WORKSPACE_DIRS["Internal"]
_EMAIL_ARCHIVE_DIR = _INTERNAL_DIR / "email_archive"
_INACTIVE_INBOX_DIR = _INTERNAL_DIR / "inbox_inactive"
_RETENTION_INDEX_PATH = _INTERNAL_DIR / "email_retention_index.json"
_INDEX_VERSION = 1
_MIGRATION_VERSION = "email_archive_v1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_token(value: str, fallback: str = "unknown") -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "", str(value or "").strip())
    return token[:80] or fallback


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value or b"").hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hide_internal_dir() -> None:
    if os.name != "nt":
        return
    try:
        subprocess.run(["attrib", "+h", str(_INTERNAL_DIR)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def _parse_readable(raw_mime: bytes) -> tuple[bool, str]:
    try:
        BytesParser(policy=default).parsebytes(raw_mime or b"")
        return True, ""
    except Exception as error:
        return False, str(error)


def _unique_path(target_path: Path) -> Path:
    if not target_path.exists():
        return target_path
    suffix = 1
    while True:
        candidate = target_path.with_name(f"{target_path.stem}__{suffix}{target_path.suffix}")
        if not candidate.exists():
            return candidate
        suffix += 1


def _saved_uid_from_path(path_value: str | Path) -> str:
    try:
        name = Path(path_value).name
        match = re.match(r"^\d+_([A-Za-z0-9]+)\.eml$", name, re.IGNORECASE)
        return match.group(1) if match else ""
    except Exception:
        return ""


def _message_id_from_raw(raw_mime: bytes) -> str:
    try:
        parsed = BytesParser(policy=default).parsebytes(raw_mime, headersonly=True)
        return str(parsed.get("Message-ID") or "").strip().strip("<>").lower()
    except Exception:
        return ""


def _normalize_ref(value: str | Path) -> str:
    return str(value or "").strip().lower().replace("\\", "/")


def load_retention_index() -> dict[str, Any]:
    try:
        data = json.loads(_RETENTION_INDEX_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    records = data.get("records")
    if not isinstance(records, dict):
        records = {}
    return {
        "version": int(data.get("version") or _INDEX_VERSION),
        "migration_version": str(data.get("migration_version") or _MIGRATION_VERSION),
        "updated_at": str(data.get("updated_at") or ""),
        "records": records,
    }


def save_retention_index(index: dict[str, Any]) -> None:
    _INTERNAL_DIR.mkdir(parents=True, exist_ok=True)
    _hide_internal_dir()
    payload = {
        "version": _INDEX_VERSION,
        "migration_version": _MIGRATION_VERSION,
        "updated_at": _utc_now(),
        "records": index.get("records") if isinstance(index.get("records"), dict) else {},
    }
    _RETENTION_INDEX_PATH.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _record_key(*, checksum: str, email_id: str = "", message_id: str = "") -> str:
    message = str(message_id or "").strip().strip("<>").lower()
    if message:
        return f"message:{message}"
    email = str(email_id or "").strip().lower()
    if email:
        return f"uid:{email}"
    return f"sha256:{checksum}"


def _archive_path_for(*, checksum: str, email_id: str, received_at: str | None = None) -> Path:
    try:
        timestamp = datetime.fromisoformat(str(received_at or "").replace("Z", "+00:00"))
    except Exception:
        timestamp = datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    timestamp = timestamp.astimezone(timezone.utc)
    safe_email_id = _safe_token(email_id)
    filename = f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}_{safe_email_id}_{checksum[:12]}.eml"
    return _EMAIL_ARCHIVE_DIR / timestamp.strftime("%Y") / timestamp.strftime("%m") / filename


def archive_raw_email(
    raw_mime: bytes | str,
    *,
    email_id: str = "",
    message_id: str = "",
    uid: str = "",
    original_inbox_path: str = "",
    linked_order_id: str = "",
    linked_conversation_id: str = "",
    status: str = "processed",
    received_at: str | None = None,
) -> dict[str, Any]:
    raw_bytes = raw_mime.encode("utf-8", errors="ignore") if isinstance(raw_mime, str) else bytes(raw_mime or b"")
    checksum = _sha256_bytes(raw_bytes)
    key = _record_key(checksum=checksum, email_id=email_id or uid, message_id=message_id)
    index = load_retention_index()
    records = index["records"]
    existing = records.get(key)
    if isinstance(existing, dict):
        archived_path = Path(str(existing.get("archive_path") or ""))
        if archived_path.is_file() and _sha256_file(archived_path) == checksum:
            record = dict(existing)
            changed = False
            for field, value in {
                "email_id": email_id or uid,
                "uid": uid or email_id,
                "message_id": message_id,
                "original_inbox_path": original_inbox_path,
                "linked_order_id": linked_order_id,
                "linked_conversation_id": linked_conversation_id,
            }.items():
                if value and not record.get(field):
                    record[field] = value
                    changed = True
            if status and record.get("status") != status and record.get("status") not in {"corrupt", "unresolved"}:
                record["status"] = status
                changed = True
            if changed:
                record["updated_at"] = _utc_now()
                records[key] = record
                save_retention_index(index)
            return record

    readable, parse_error = _parse_readable(raw_bytes)
    archive_path = _archive_path_for(checksum=checksum, email_id=email_id or uid, received_at=received_at)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    _hide_internal_dir()
    tmp_path = archive_path.with_suffix(archive_path.suffix + ".tmp")
    tmp_path.write_bytes(raw_bytes)
    if _sha256_file(tmp_path) != checksum:
        tmp_path.unlink(missing_ok=True)
        raise IOError("email archive checksum verification failed before publish")
    if not archive_path.exists():
        tmp_path.replace(archive_path)
    else:
        tmp_path.unlink(missing_ok=True)
    verified = archive_path.is_file() and _sha256_file(archive_path) == checksum
    if not verified:
        raise IOError("email archive checksum verification failed after publish")

    now = _utc_now()
    record = {
        "email_id": str(email_id or uid or "").strip(),
        "message_id": str(message_id or "").strip(),
        "uid": str(uid or email_id or "").strip(),
        "checksum": checksum,
        "original_inbox_path": str(original_inbox_path or "").strip(),
        "archive_path": str(archive_path),
        "linked_order_id": str(linked_order_id or "").strip(),
        "linked_conversation_id": str(linked_conversation_id or "").strip(),
        "status": status if readable else "corrupt",
        "processed_at": now if status in {"processed", "processed_archived", "archived"} else "",
        "archived_at": now,
        "migration_version": _MIGRATION_VERSION,
        "parse_readable": readable,
        "parse_error": parse_error,
        "verified": verified,
        "created_at": now,
        "updated_at": now,
    }
    records[key] = record
    save_retention_index(index)
    print(
        "[EMAIL_ARCHIVE_WRITE] "
        + json.dumps(
            {
                "email_id": record["email_id"],
                "message_id": record["message_id"],
                "status": record["status"],
                "archive_path": record["archive_path"],
                "checksum": checksum,
                "verified": verified,
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
        flush=True,
    )
    return record


def move_archived_inbox_file_to_inactive(
    source_path: str | Path,
    *,
    reason: str,
    email_id: str = "",
    message_id: str = "",
    linked_order_id: str = "",
    linked_conversation_id: str = "",
) -> dict[str, Any]:
    path = Path(source_path)
    if not path.is_file():
        return {"moved": False, "reason": "source_missing", "path": str(path)}
    raw = path.read_bytes()
    if not message_id:
        message_id = _message_id_from_raw(raw)
    uid = email_id or _saved_uid_from_path(path)
    record = archive_raw_email(
        raw,
        email_id=uid,
        uid=uid,
        message_id=message_id,
        original_inbox_path=str(path),
        linked_order_id=linked_order_id,
        linked_conversation_id=linked_conversation_id,
        status="inactive_archived",
    )
    archive_path = Path(str(record.get("archive_path") or ""))
    checksum = str(record.get("checksum") or "")
    if not archive_path.is_file() or not checksum or _sha256_file(archive_path) != checksum:
        return {"moved": False, "reason": "archive_not_verified", "path": str(path)}

    target_dir = _INACTIVE_INBOX_DIR / datetime.now(timezone.utc).strftime("%Y%m%d")
    target_dir.mkdir(parents=True, exist_ok=True)
    _hide_internal_dir()
    target_path = _unique_path(target_dir / path.name)
    shutil.move(str(path), str(target_path))

    index = load_retention_index()
    key = _record_key(checksum=checksum, email_id=uid, message_id=message_id)
    current = index["records"].get(key)
    if isinstance(current, dict):
        current["inactive_path"] = str(target_path)
        current["inactive_reason"] = str(reason or "").strip()
        current["status"] = "inactive_archived"
        current["updated_at"] = _utc_now()
        index["records"][key] = current
        save_retention_index(index)

    print(
        "[INBOX_LIFECYCLE_MOVE] "
        + json.dumps(
            {
                "source": str(path),
                "inactive_path": str(target_path),
                "archive_path": str(archive_path),
                "reason": reason,
                "checksum": checksum,
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
        flush=True,
    )
    return {
        "moved": True,
        "source": str(path),
        "inactive_path": str(target_path),
        "archive_path": str(archive_path),
        "reason": reason,
        "checksum": checksum,
    }


def sync_active_inbox_lifecycle(
    inbox_dir: str | Path,
    *,
    hidden_ids: set[str] | None = None,
    processed_refs: set[str] | None = None,
    source_deleted_uids: set[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    inbox = Path(inbox_dir)
    hidden = {_normalize_ref(value) for value in (hidden_ids or set()) if str(value or "").strip()}
    processed = {_normalize_ref(value) for value in (processed_refs or set()) if str(value or "").strip()}
    source_deleted = {str(value or "").strip().lower() for value in (source_deleted_uids or set()) if str(value or "").strip()}
    result: dict[str, Any] = {"dry_run": bool(dry_run), "moved": 0, "kept": 0, "failed": 0, "items": []}
    if not inbox.is_dir():
        return result
    for path in sorted(inbox.glob("*.eml")):
        try:
            raw = path.read_bytes()
            message_id = _message_id_from_raw(raw)
        except Exception as error:
            result["failed"] += 1
            result["items"].append({"path": str(path), "action": "keep", "reason": f"parse_error:{error}"})
            continue
        uid = _saved_uid_from_path(path)
        refs = {
            _normalize_ref(path),
            _normalize_ref(path.name),
            _normalize_ref(uid),
            _normalize_ref(message_id),
            f"uid:{_normalize_ref(uid)}" if uid else "",
        }
        reasons: list[str] = []
        if refs.intersection(hidden):
            reasons.append("hidden")
        if refs.intersection(processed):
            reasons.append("processed_ref")
        if uid and uid.lower() in source_deleted:
            reasons.append("provider_source_deleted")
        if not reasons:
            result["kept"] += 1
            result["items"].append({"path": str(path), "action": "keep", "reason": "active_or_unmatched"})
            continue
        reason = "+".join(reasons)
        if dry_run:
            result["items"].append({"path": str(path), "action": "would_move", "reason": reason})
            continue
        try:
            moved = move_archived_inbox_file_to_inactive(path, reason=reason, email_id=uid, message_id=message_id)
            if moved.get("moved"):
                result["moved"] += 1
                result["items"].append({"path": str(path), "action": "moved", "reason": reason, **moved})
            else:
                result["failed"] += 1
                result["items"].append({"path": str(path), "action": "keep", "reason": moved.get("reason") or reason})
        except Exception as error:
            result["failed"] += 1
            result["items"].append({"path": str(path), "action": "keep", "reason": f"move_error:{error}"})
    return result


def archive_existing_eml(
    source_path: str | Path,
    *,
    email_id: str = "",
    message_id: str = "",
    linked_order_id: str = "",
    linked_conversation_id: str = "",
    status: str = "processed",
) -> dict[str, Any]:
    path = Path(source_path)
    raw = path.read_bytes()
    if not message_id:
        try:
            parsed = BytesParser(policy=default).parsebytes(raw)
            message_id = str(parsed.get("Message-ID") or "").strip().strip("<>").lower()
        except Exception:
            message_id = ""
    return archive_raw_email(
        raw,
        email_id=email_id,
        uid=email_id,
        message_id=message_id,
        original_inbox_path=str(path),
        linked_order_id=linked_order_id,
        linked_conversation_id=linked_conversation_id,
        status=status,
    )


def update_retention_record(
    *,
    email_id: str = "",
    message_id: str = "",
    checksum: str = "",
    linked_order_id: str = "",
    linked_conversation_id: str = "",
    status: str | None = None,
) -> dict[str, Any] | None:
    key = _record_key(checksum=checksum, email_id=email_id, message_id=message_id)
    index = load_retention_index()
    record = index["records"].get(key)
    if not isinstance(record, dict):
        return None
    if linked_order_id:
        record["linked_order_id"] = str(linked_order_id)
    if linked_conversation_id:
        record["linked_conversation_id"] = str(linked_conversation_id)
    if status:
        record["status"] = str(status)
        if status in {"archived", "processed_archived"} and not record.get("processed_at"):
            record["processed_at"] = _utc_now()
    record["updated_at"] = _utc_now()
    index["records"][key] = record
    save_retention_index(index)
    print(
        "[EMAIL_RETENTION_UPDATE] "
        + json.dumps(
            {
                "email_id": record.get("email_id") or "",
                "message_id": record.get("message_id") or "",
                "status": record.get("status") or "",
                "linked_order_id": record.get("linked_order_id") or "",
                "linked_conversation_id": record.get("linked_conversation_id") or "",
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
        flush=True,
    )
    return record


def migrate_processed_inbox_files(
    inbox_dir: str | Path,
    processed_refs: set[str],
    *,
    dry_run: bool = True,
    grace_days: int = 14,
) -> dict[str, Any]:
    """Classify/copy processed inbox files without deleting active inbox data.

    Cleanup is intentionally out of scope for the first lifecycle step. The
    migration only creates verified archive copies and retention records.
    """
    inbox = Path(inbox_dir)
    results: dict[str, Any] = {
        "dry_run": bool(dry_run),
        "grace_days": max(0, int(grace_days or 0)),
        "copied": 0,
        "skipped": 0,
        "unresolved": 0,
        "corrupt": 0,
        "items": [],
    }
    normalized_refs = {str(ref or "").strip().lower() for ref in processed_refs if str(ref or "").strip()}
    for path in sorted(inbox.glob("*.eml")):
        ref_variants = {str(path).strip().lower(), path.name.strip().lower()}
        if normalized_refs and not ref_variants.intersection(normalized_refs):
            results["skipped"] += 1
            results["items"].append({"path": str(path), "status": "active_or_unmatched", "action": "skip"})
            continue
        try:
            raw = path.read_bytes()
            message = BytesParser(policy=default).parsebytes(raw)
            message_id = str(message.get("Message-ID") or "").strip().strip("<>").lower()
        except Exception as error:
            results["corrupt"] += 1
            results["items"].append({"path": str(path), "status": "corrupt", "error": str(error), "action": "skip"})
            continue
        if dry_run:
            results["items"].append({"path": str(path), "status": "processed", "action": "would_archive"})
            continue
        record = archive_existing_eml(path, email_id="", message_id=message_id, status="processed_archived")
        results["copied"] += 1
        results["items"].append({"path": str(path), "status": record.get("status"), "archive_path": record.get("archive_path")})
    return results
