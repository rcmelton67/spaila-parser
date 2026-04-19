import argparse
import copy
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from parser.ingest import load_eml
from parser.sanitize import sanitize
from parser.replay.fingerprint import compute_template_id


STORE_PATH = Path("parser/learning/learning_store.json")
SAMPLES_DIR = Path("tests/samples")
STRONG_FIELDS = {
    "order_number",
    "buyer_email",
    "buyer_name",
    "shipping_address",
    "ship_by",
    "order_date",
}


@dataclass
class SampleInfo:
    name: str
    path: Path
    subject: str
    clean_text: str
    template_id: str


@dataclass
class MappingResult:
    old_template_id: str
    new_template_id: Optional[str]
    source_sample: Optional[str]
    strong_hits: int
    total_hits: int
    clean: bool
    reason: str


def load_store() -> Dict[str, List[Dict]]:
    if not STORE_PATH.exists():
        return {}
    return json.loads(STORE_PATH.read_text(encoding="utf-8"))


def load_samples() -> List[SampleInfo]:
    samples: List[SampleInfo] = []
    for path in sorted(SAMPLES_DIR.glob("*.eml")):
        ingested = load_eml(str(path))
        clean_text = sanitize(ingested)
        samples.append(SampleInfo(
            name=path.name,
            path=path,
            subject=ingested.get("subject", ""),
            clean_text=clean_text,
            template_id=compute_template_id(clean_text),
        ))
    return samples


def record_strings(record: Dict) -> List[str]:
    values: List[str] = []
    for key in ("selected_text", "value", "segment_text"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value)
    return values


def score_sample(records: List[Dict], sample: SampleInfo) -> Dict:
    haystack = f"{sample.clean_text}\n{sample.subject}"
    strong_hits = 0
    total_hits = 0
    matched_fields: List[str] = []

    for record in records:
        hit = False
        for value in record_strings(record):
            if value in haystack:
                hit = True
                break

        if not hit:
            continue

        total_hits += 1
        if record.get("field") in STRONG_FIELDS:
            strong_hits += 1
            matched_fields.append(record.get("field", ""))

    return {
        "sample": sample,
        "strong_hits": strong_hits,
        "total_hits": total_hits,
        "matched_fields": matched_fields,
    }


def map_template_id(old_template_id: str, records: List[Dict], samples: List[SampleInfo]) -> MappingResult:
    scored = sorted(
        (score_sample(records, sample) for sample in samples),
        key=lambda row: (row["strong_hits"], row["total_hits"], row["sample"].name),
        reverse=True,
    )

    best = scored[0] if scored else None
    second = scored[1] if len(scored) > 1 else None

    if not best or best["strong_hits"] == 0:
        return MappingResult(
            old_template_id=old_template_id,
            new_template_id=None,
            source_sample=None,
            strong_hits=0,
            total_hits=best["total_hits"] if best else 0,
            clean=False,
            reason="no strong sample match",
        )

    if second and best["strong_hits"] == second["strong_hits"]:
        return MappingResult(
            old_template_id=old_template_id,
            new_template_id=None,
            source_sample=None,
            strong_hits=best["strong_hits"],
            total_hits=best["total_hits"],
            clean=False,
            reason="ambiguous strong match",
        )

    if best["strong_hits"] < 2:
        return MappingResult(
            old_template_id=old_template_id,
            new_template_id=None,
            source_sample=None,
            strong_hits=best["strong_hits"],
            total_hits=best["total_hits"],
            clean=False,
            reason="insufficient strong evidence",
        )

    return MappingResult(
        old_template_id=old_template_id,
        new_template_id=best["sample"].template_id,
        source_sample=best["sample"].name,
        strong_hits=best["strong_hits"],
        total_hits=best["total_hits"],
        clean=True,
        reason="clean sample-backed remap",
    )


def build_report(store: Dict[str, List[Dict]], samples: List[SampleInfo]) -> List[MappingResult]:
    return [map_template_id(old_id, records, samples) for old_id, records in store.items()]


def make_backup() -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = STORE_PATH.with_name(f"learning_store.backup.{timestamp}.json")
    backup_path.write_text(STORE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    return backup_path


def migrated_signature(record: Dict) -> str:
    signature_record = {
        key: value
        for key, value in record.items()
        if key != "template_id"
    }
    return json.dumps(signature_record, sort_keys=True, ensure_ascii=False)


def migrate_store(store: Dict[str, List[Dict]], report: List[MappingResult]) -> Dict[str, List[Dict]]:
    migrated = copy.deepcopy(store)
    mapped = {
        row.old_template_id: row.new_template_id
        for row in report
        if row.clean and row.new_template_id
    }

    for old_template_id, new_template_id in mapped.items():
        destination = migrated.setdefault(new_template_id, [])
        existing_signatures = {migrated_signature(record) for record in destination}

        for record in store.get(old_template_id, []):
            migrated_record = copy.deepcopy(record)
            migrated_record["template_id"] = new_template_id
            migrated_record["migrated_from_template_id"] = old_template_id
            signature = migrated_signature(migrated_record)
            if signature in existing_signatures:
                continue
            destination.append(migrated_record)
            existing_signatures.add(signature)

    return migrated


def print_report(report: List[MappingResult]) -> None:
    total = len(report)
    clean = sum(1 for row in report if row.clean)
    unmapped = total - clean

    print(f"Total old template_ids: {total}")
    print(f"Clean single-template remaps: {clean}")
    print(f"Unmapped or ambiguous: {unmapped}")
    print()

    for row in report:
        if row.clean:
            print(
                f"{row.old_template_id} -> {row.new_template_id} "
                f"[sample={row.source_sample}, strong_hits={row.strong_hits}, total_hits={row.total_hits}]"
            )
        else:
            print(
                f"{row.old_template_id} -> UNMAPPED "
                f"[reason={row.reason}, strong_hits={row.strong_hits}, total_hits={row.total_hits}]"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Report or migrate learning store template IDs.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the migrated learning store after creating a backup.",
    )
    args = parser.parse_args()

    store = load_store()
    samples = load_samples()
    report = build_report(store, samples)
    print_report(report)

    if not args.apply:
        return

    backup_path = make_backup()
    migrated = migrate_store(store, report)
    STORE_PATH.write_text(json.dumps(migrated, indent=2, ensure_ascii=False), encoding="utf-8")
    print()
    print(f"Backup written to: {backup_path}")
    print(f"Migrated store written to: {STORE_PATH}")


if __name__ == "__main__":
    main()
