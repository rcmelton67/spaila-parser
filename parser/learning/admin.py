import argparse
import copy
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple
from uuid import uuid4

from . import confidence_store
from . import store as learning_store

DEFAULT_AUDIT_DIR = Path("parser/learning/audit")
DEFAULT_BACKUP_DIR = Path("parser/learning/backups")
MUTATING_OPERATIONS = {
    "remove_assignment",
    "quarantine_signature",
    "demote_trust",
    "restore",
    "reset_field",
}


@dataclass
class AdminPaths:
    learning_store_path: Path
    confidence_store_path: Path
    audit_dir: Path = DEFAULT_AUDIT_DIR
    backup_dir: Path = DEFAULT_BACKUP_DIR


def default_paths() -> AdminPaths:
    return AdminPaths(
        learning_store_path=Path(learning_store.STORE_PATH),
        confidence_store_path=Path(confidence_store.CONFIDENCE_STORE_PATH),
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return copy.deepcopy(default)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return copy.deepcopy(default)


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=f"{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(payload, file, indent=2, ensure_ascii=False)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _sha256(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _scope_is_specific(selector: Dict[str, Any]) -> bool:
    if selector.get("operation") == "restore":
        return bool(selector.get("audit_id"))
    if not selector.get("field"):
        return False
    scope_keys = {
        "template_id",
        "source",
        "value",
        "learned_signature",
        "structural_signature",
        "record_type",
    }
    return any(selector.get(key) not in (None, "") for key in scope_keys)


def _record_matches(record: Dict[str, Any], template_id: str, selector: Dict[str, Any]) -> bool:
    field = selector.get("field")
    if field and record.get("field", "") != field:
        return False
    if selector.get("template_id") and template_id != selector.get("template_id"):
        return False
    if selector.get("source") and record.get("source", "") != selector.get("source"):
        return False
    if selector.get("value") and str(record.get("value", "")) != str(selector.get("value")):
        return False
    if selector.get("learned_signature") and record.get("learned_signature", "") != selector.get("learned_signature"):
        return False
    if selector.get("structural_signature") and record.get("structural_signature", "") != selector.get("structural_signature"):
        return False
    if selector.get("record_type") and record.get("type", "assign") != selector.get("record_type"):
        return False
    return True


def _confidence_matches(key: str, record: Dict[str, Any], selector: Dict[str, Any]) -> bool:
    if selector.get("field") and record.get("field", "") != selector.get("field"):
        return False
    if selector.get("template_id") and record.get("template_id", "") != selector.get("template_id"):
        return False
    if selector.get("source") and record.get("source", "") not in {"", selector.get("source")}:
        return False
    signature = selector.get("learned_signature") or selector.get("extraction_signature")
    if signature and record.get("extraction_signature", "") != signature and signature not in key:
        return False
    return True


def _preview_score(match_count: int, operation: str, selector: Dict[str, Any]) -> float:
    if match_count <= 0:
        return 0.0
    score = min(1.0, match_count / 10)
    if selector.get("template_id"):
        score *= 0.75
    if selector.get("source"):
        score *= 0.75
    if selector.get("value") or selector.get("learned_signature") or selector.get("structural_signature"):
        score *= 0.6
    if operation in {"reset_field", "quarantine_signature"}:
        score += 0.1
    return round(min(1.0, score), 4)


def _learning_matches(learning: Dict[str, List[Dict[str, Any]]], selector: Dict[str, Any]) -> List[Dict[str, Any]]:
    matches: List[Dict[str, Any]] = []
    for template_id, records in learning.items():
        for index, record in enumerate(records):
            if _record_matches(record, template_id, selector):
                matches.append({
                    "store": "learning",
                    "template_id": template_id,
                    "index": index,
                    "record": copy.deepcopy(record),
                })
    return matches


def _confidence_matches_for_store(confidence: Dict[str, Dict[str, Any]], selector: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {"store": "confidence", "key": key, "record": copy.deepcopy(record)}
        for key, record in confidence.items()
        if _confidence_matches(key, record, selector)
    ]


def inspect(selector: Dict[str, Any], paths: AdminPaths | None = None) -> Dict[str, Any]:
    paths = paths or default_paths()
    learning = _read_json(paths.learning_store_path, {})
    confidence = _read_json(paths.confidence_store_path, {})
    learning_matches = _learning_matches(learning, selector)
    confidence_matches = _confidence_matches_for_store(confidence, selector)
    operation = selector.get("operation", "inspect")
    match_count = len(learning_matches) + len(confidence_matches)
    return {
        "operation": operation,
        "dry_run": True,
        "scope_valid": _scope_is_specific(selector),
        "mutation_preview_score": _preview_score(match_count, operation, selector),
        "matched_count": match_count,
        "learning_matches": learning_matches,
        "confidence_matches": confidence_matches,
        "store_hashes": {
            "learning_before": _sha256(paths.learning_store_path),
            "confidence_before": _sha256(paths.confidence_store_path),
        },
    }


def _mutate_learning_record(record: Dict[str, Any], operation: str, selector: Dict[str, Any], now: str) -> Dict[str, Any]:
    after = copy.deepcopy(record)
    reason = selector.get("reason", "admin_unlearn_restore")
    if operation == "remove_assignment":
        after["active"] = False
        after["quarantined"] = True
        after["quarantine_reason"] = reason or "admin_removed_assignment"
        after["unlearned_at"] = now
    elif operation == "quarantine_signature":
        after["active"] = False if after.get("type", "assign") == "assign" else after.get("active", True)
        after["quarantined"] = True
        after["quarantine_reason"] = reason or "admin_quarantined_signature"
        if after.get("type") == "structural_trust":
            after["trust_state"] = "quarantined"
    elif operation == "demote_trust":
        after["trust_state"] = "demoted"
        after["quarantined"] = False
        after["quarantine_reason"] = ""
        after["negative_corrections"] = int(after.get("negative_corrections") or 0) + 1
        after["demotion_count"] = int(after.get("demotion_count") or 0) + 1
        after["trust_score"] = min(float(after.get("trust_score") or 0.0) - 1.25, -1.0)
    elif operation == "reset_field":
        after["active"] = False
        after["quarantined"] = True
        after["quarantine_reason"] = reason or "admin_field_reset"
        after["reset_at"] = now
    after.setdefault("last_used_at", record.get("last_used_at", ""))
    after["admin_last_touched_at"] = now
    return after


def _planned_changes(
    learning: Dict[str, List[Dict[str, Any]]],
    confidence: Dict[str, Dict[str, Any]],
    selector: Dict[str, Any],
    now: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]], Dict[str, Dict[str, Any]]]:
    operation = selector.get("operation", "inspect")
    next_learning = copy.deepcopy(learning)
    next_confidence = copy.deepcopy(confidence)
    changes: List[Dict[str, Any]] = []

    for match in _learning_matches(learning, selector):
        before = match["record"]
        if operation == "remove_assignment" and before.get("type", "assign") != "assign":
            continue
        if operation == "demote_trust" and before.get("type") != "structural_trust":
            continue
        after = _mutate_learning_record(before, operation, selector, now)
        template_id = match["template_id"]
        index = match["index"]
        next_learning[template_id][index] = after
        changes.append({**match, "before": before, "after": after})

    if operation in {"quarantine_signature", "reset_field"}:
        for match in _confidence_matches_for_store(confidence, selector):
            key = match["key"]
            before = match["record"]
            del next_confidence[key]
            changes.append({**match, "before": before, "after": None})

    return changes, next_learning, next_confidence


def _write_backup(paths: AdminPaths, audit_id: str) -> Dict[str, str]:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    paths.backup_dir.mkdir(parents=True, exist_ok=True)
    learning_backup = paths.backup_dir / f"learning_store.{timestamp}.{audit_id}.json"
    confidence_backup = paths.backup_dir / f"confidence_store.{timestamp}.{audit_id}.json"
    learning_backup.write_text(
        paths.learning_store_path.read_text(encoding="utf-8") if paths.learning_store_path.exists() else "{}",
        encoding="utf-8",
    )
    confidence_backup.write_text(
        paths.confidence_store_path.read_text(encoding="utf-8") if paths.confidence_store_path.exists() else "{}",
        encoding="utf-8",
    )
    return {
        "learning_store": str(learning_backup),
        "confidence_store": str(confidence_backup),
    }


def _append_audit(paths: AdminPaths, entry: Dict[str, Any]) -> str:
    paths.audit_dir.mkdir(parents=True, exist_ok=True)
    audit_path = paths.audit_dir / "unlearn_restore.jsonl"
    with audit_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    return str(audit_path)


def _load_audit_entry(paths: AdminPaths, audit_id: str) -> Dict[str, Any]:
    audit_path = paths.audit_dir / "unlearn_restore.jsonl"
    if not audit_path.exists():
        raise ValueError(f"audit log not found: {audit_path}")
    for line in audit_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("audit_id") == audit_id:
            return entry
    raise ValueError(f"audit entry not found: {audit_id}")


def apply(selector: Dict[str, Any], paths: AdminPaths | None = None) -> Dict[str, Any]:
    paths = paths or default_paths()
    operation = selector.get("operation", "")
    dry_run = bool(selector.get("dry_run", True))
    if operation not in MUTATING_OPERATIONS and operation != "inspect":
        raise ValueError(f"unsupported operation: {operation}")
    if operation == "restore":
        if not selector.get("audit_id"):
            raise ValueError("restore requires audit_id")
        return restore(selector["audit_id"], paths=paths, dry_run=dry_run)
    if operation == "inspect" or dry_run:
        return inspect(selector, paths)
    if not _scope_is_specific(selector):
        raise ValueError("mutation requires field plus at least one scope selector")

    learning = _read_json(paths.learning_store_path, {})
    confidence = _read_json(paths.confidence_store_path, {})
    now = _utc_now()
    audit_id = selector.get("audit_id") or uuid4().hex[:12]
    changes, next_learning, next_confidence = _planned_changes(learning, confidence, selector, now)
    match_count = len(changes)
    audit_entry = {
        "audit_id": audit_id,
        "timestamp": now,
        "operation": operation,
        "operator": selector.get("operator", "cli"),
        "reason": selector.get("reason", ""),
        "selector": selector,
        "mutation_preview_score": _preview_score(match_count, operation, selector),
        "matched_count": match_count,
        "store_hashes_before": {
            "learning": _sha256(paths.learning_store_path),
            "confidence": _sha256(paths.confidence_store_path),
        },
        "changes": changes,
        "status": "planned",
    }
    backups = _write_backup(paths, audit_id)
    audit_entry["backups"] = backups
    audit_path = _append_audit(paths, audit_entry)

    _atomic_write_json(paths.learning_store_path, next_learning)
    _atomic_write_json(paths.confidence_store_path, next_confidence)

    audit_entry["status"] = "applied"
    audit_entry["audit_log"] = audit_path
    audit_entry["store_hashes_after"] = {
        "learning": _sha256(paths.learning_store_path),
        "confidence": _sha256(paths.confidence_store_path),
    }
    _append_audit(paths, audit_entry)
    return audit_entry


def restore(audit_id: str, paths: AdminPaths | None = None, dry_run: bool = True) -> Dict[str, Any]:
    paths = paths or default_paths()
    entry = _load_audit_entry(paths, audit_id)
    learning = _read_json(paths.learning_store_path, {})
    confidence = _read_json(paths.confidence_store_path, {})
    next_learning = copy.deepcopy(learning)
    next_confidence = copy.deepcopy(confidence)
    changes: List[Dict[str, Any]] = []

    for change in entry.get("changes", []):
        if change.get("store") == "learning":
            template_id = change["template_id"]
            index = change["index"]
            before = change["before"]
            current = next_learning.get(template_id, [])[index]
            expected_after = change.get("after")
            if expected_after is not None and current != expected_after:
                raise ValueError(f"restore conflict for learning record {template_id}[{index}]")
            next_learning[template_id][index] = before
            changes.append({"store": "learning", "template_id": template_id, "index": index, "before": current, "after": before})
        elif change.get("store") == "confidence":
            key = change["key"]
            current = next_confidence.get(key)
            expected_after = change.get("after")
            if expected_after is not None and current != expected_after:
                raise ValueError(f"restore conflict for confidence record {key}")
            before = change["before"]
            next_confidence[key] = before
            changes.append({"store": "confidence", "key": key, "before": current, "after": before})

    result = {
        "operation": "restore",
        "dry_run": dry_run,
        "audit_id": audit_id,
        "matched_count": len(changes),
        "mutation_preview_score": _preview_score(len(changes), "restore", {"field": "restore", "audit_id": audit_id}),
        "changes": changes,
    }
    if dry_run:
        return result

    restore_audit_id = uuid4().hex[:12]
    backups = _write_backup(paths, restore_audit_id)
    audit_entry = {
        **result,
        "dry_run": False,
        "restore_audit_id": restore_audit_id,
        "timestamp": _utc_now(),
        "backups": backups,
        "store_hashes_before": {
            "learning": _sha256(paths.learning_store_path),
            "confidence": _sha256(paths.confidence_store_path),
        },
        "status": "planned",
    }
    audit_path = _append_audit(paths, audit_entry)
    _atomic_write_json(paths.learning_store_path, next_learning)
    _atomic_write_json(paths.confidence_store_path, next_confidence)
    audit_entry["status"] = "applied"
    audit_entry["audit_log"] = audit_path
    audit_entry["store_hashes_after"] = {
        "learning": _sha256(paths.learning_store_path),
        "confidence": _sha256(paths.confidence_store_path),
    }
    _append_audit(paths, audit_entry)
    return audit_entry


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Admin-safe parser learning unlearn/restore controls")
    parser.add_argument("operation", choices=sorted(MUTATING_OPERATIONS | {"inspect"}))
    parser.add_argument("--field", default="")
    parser.add_argument("--template-id", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--value", default="")
    parser.add_argument("--signature", dest="learned_signature", default="")
    parser.add_argument("--structural-signature", default="")
    parser.add_argument("--record-type", default="")
    parser.add_argument("--reason", default="")
    parser.add_argument("--operator", default="cli")
    parser.add_argument("--audit-id", default="")
    parser.add_argument("--apply", action="store_true")
    return parser


def main(argv: List[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    selector = {
        "operation": args.operation,
        "field": args.field,
        "template_id": args.template_id,
        "source": args.source,
        "value": args.value,
        "learned_signature": args.learned_signature,
        "structural_signature": args.structural_signature,
        "record_type": args.record_type,
        "reason": args.reason,
        "operator": args.operator,
        "audit_id": args.audit_id,
        "dry_run": not args.apply,
    }
    if args.operation == "restore":
        result = restore(args.audit_id, dry_run=not args.apply)
    else:
        result = apply(selector)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
