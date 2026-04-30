from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def file_sha256(path: str | Path) -> str:
    target = Path(path)
    if not target.exists():
        return ""
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_json_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def read_json(path: str | Path) -> Any:
    target = Path(path)
    if not target.exists():
        return {}
    with target.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: str | Path, payload: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)


def decision_snapshot(parse_result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for decision in parse_result.get("decisions", []):
        rows.append(
            {
                "field": decision.field,
                "value": "" if decision.value is None else str(decision.value),
                "decision": decision.decision,
                "decision_source": decision.decision_source,
                "confidence": round(float(decision.confidence or 0.0), 4),
                "candidate_id": decision.candidate_id,
                "signals": list(decision.provenance.get("signals", [])),
            }
        )
    return sorted(rows, key=lambda row: row["field"])


def store_summary(learning_store_payload: dict[str, Any]) -> dict[str, Any]:
    records = [
        record
        for values in learning_store_payload.values()
        if isinstance(values, list)
        for record in values
        if isinstance(record, dict)
    ]
    structural_trust = [
        record for record in records
        if record.get("type") == "structural_trust" or record.get("trust_state")
    ]
    quarantined = [record for record in records if record.get("quarantined")]
    return {
        "record_count": len(records),
        "structural_trust_count": len(structural_trust),
        "quarantined_count": len(quarantined),
        "fields": sorted({record.get("field", "") for record in records if record.get("field")}),
        "trust_hash": stable_json_hash(structural_trust),
    }


def diff_store_summaries(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_delta": int(after.get("record_count", 0)) - int(before.get("record_count", 0)),
        "structural_trust_delta": (
            int(after.get("structural_trust_count", 0)) - int(before.get("structural_trust_count", 0))
        ),
        "quarantined_delta": (
            int(after.get("quarantined_count", 0)) - int(before.get("quarantined_count", 0))
        ),
        "trust_hash_changed": before.get("trust_hash") != after.get("trust_hash"),
    }

