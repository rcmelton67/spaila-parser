import json
import os
import sys
from typing import Dict, List, Optional
from datetime import datetime, timezone

STORE_PATH = "parser/learning/learning_store.json"


def _normalize_value(value) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())


def load_store() -> Dict[str, List[Dict]]:
    if not os.path.exists(STORE_PATH):
        return {}
    with open(STORE_PATH, "r") as f:
        return json.load(f)


def save_store(store: Dict[str, List[Dict]]) -> None:
    with open(STORE_PATH, "w") as f:
        json.dump(store, f, indent=2)


def _normalize_record(record: Dict) -> Dict:
    return {
        "field": record.get("field", ""),
        "value": record.get("value", ""),
        "template_id": record.get("template_id", ""),
        "source": record.get("source", ""),
        "segment_id": record.get("segment_id", ""),
        "start": record.get("start", 0),
        "end": record.get("end", 0),
        "selected_text": record.get("selected_text", ""),
        "segment_text": record.get("segment_text", ""),
        "left_context": record.get("left_context", ""),
        "right_context": record.get("right_context", ""),
        "candidate_id": record.get("candidate_id", ""),
        "extractor": record.get("extractor", ""),
        "learned_signature": record.get("learned_signature", ""),
        "type": record.get("type", "assign"),
        "active": record.get("active", True),
        "created_at": record.get("created_at", ""),
    }


def _record_matches(existing: Dict, incoming: Dict) -> bool:
    if incoming["type"] == "assign":
        return (
            existing.get("type") == "assign"
            and existing.get("field") == incoming["field"]
            and (
                incoming["field"] != "quantity"
                or existing.get("source", "") == incoming.get("source", "")
            )
        )
    return (
        existing.get("type") == incoming["type"]
        and existing.get("field") == incoming["field"]
        and existing.get("value") == incoming["value"]
        and existing.get("segment_text", "") == incoming["segment_text"]
        and existing.get("left_context", "") == incoming["left_context"]
        and existing.get("right_context", "") == incoming["right_context"]
        and (
            incoming["field"] != "quantity"
            or existing.get("source", "") == incoming.get("source", "")
        )
    )


def save_record(record: Dict) -> None:
    record = _normalize_record(record)
    template_id = record["template_id"]
    store = load_store()
    records = store.setdefault(template_id, [])

    for i, existing in enumerate(records):
        if not _record_matches(existing, record):
            continue

        merged = _normalize_record(existing)
        merged["value"] = record["value"] or merged["value"]
        merged["segment_id"] = record["segment_id"] or merged["segment_id"]
        merged["start"] = record["start"] or merged["start"]
        merged["end"] = record["end"] or merged["end"]
        merged["selected_text"] = record["selected_text"] or merged["selected_text"]
        merged["segment_text"] = record["segment_text"] or merged["segment_text"]
        merged["left_context"] = record["left_context"] or merged["left_context"]
        merged["right_context"] = record["right_context"] or merged["right_context"]
        merged["candidate_id"] = record["candidate_id"] or merged["candidate_id"]
        merged["extractor"] = record["extractor"] or merged["extractor"]
        merged["learned_signature"] = record["learned_signature"] or merged["learned_signature"]
        merged["type"] = record["type"]
        merged["field"] = record["field"]
        merged["template_id"] = template_id
        merged["active"] = record["active"]
        merged["created_at"] = record["created_at"] or merged["created_at"]
        records[i] = merged
        save_store(store)
        return

    records.append(record)
    save_store(store)


def _deactivate_field_rejections(
    store: Dict[str, List[Dict]],
    template_id: str,
    field: str,
    source: str = "",
) -> None:
    for record in store.get(template_id, []):
        if record.get("type") != "reject":
            continue
        if record.get("field") != field:
            continue
        if field == "quantity" and record.get("source", "") != source:
            continue
        record["active"] = False


def _deactivate_matching_assignments(
    store: Dict[str, List[Dict]],
    template_id: str,
    field: str,
    value: str,
    segment_text: str,
    left_context: str,
    right_context: str,
    source: str = "",
) -> None:
    for record in store.get(template_id, []):
        if record.get("type") != "assign":
            continue
        if record.get("field") != field or record.get("value") != value:
            continue
        if field == "quantity" and record.get("source", "") != source:
            continue
        record["active"] = False


def save_assignment(template_id: str, field: str, value: str, context=None) -> None:
    value = _normalize_value(value)
    source = ""
    segment_id = getattr(context, "segment_id", "")
    start = getattr(context, "start", 0)
    end = getattr(context, "end", 0)
    selected_text = getattr(context, "selected_text", "")
    segment_text = getattr(context, "segment_text", "")
    left_context = getattr(context, "left_context", "")
    right_context = getattr(context, "right_context", "")
    candidate_id = getattr(context, "candidate_id", "")
    extractor = getattr(context, "extractor", "")
    learned_signature = getattr(context, "learned_signature", "")
    source = getattr(context, "source", "")
    if isinstance(context, dict):
        source = context.get("source", "")
        segment_id = context.get("segment_id", "")
        start = context.get("start", 0)
        end = context.get("end", 0)
        selected_text = context.get("selected_text", "")
        segment_text = context.get("segment_text", "")
        left_context = context.get("left_context", "")
        right_context = context.get("right_context", "")
        candidate_id = context.get("candidate_id", "")
        extractor = context.get("extractor", "")
        learned_signature = context.get("learned_signature", "")
    store = load_store()
    _deactivate_field_rejections(store, template_id, field, source)
    save_store(store)
    payload = {
        "field": field,
        "value": value,
        "template_id": template_id,
        "source": source if field == "quantity" else "",
        "segment_id": segment_id,
        "start": start,
        "end": end,
        "selected_text": selected_text,
        "segment_text": segment_text,
        "left_context": left_context,
        "right_context": right_context,
        "candidate_id": candidate_id,
        "extractor": extractor,
        "learned_signature": learned_signature or extractor,
        "type": "assign",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if field == "quantity":
        print(
            f"QUANTITY_LEARNING {{ learned_from: {candidate_id or extractor or 'UNKNOWN'},"
            f" value: {value}, stored: {json.dumps({k: payload[k] for k in ['source', 'candidate_id', 'extractor', 'learned_signature', 'segment_id', 'segment_text', 'left_context', 'right_context']})} }}",
            file=sys.stderr,
            flush=True,
        )
    save_record(payload)


def save_rejection(template_id: str, field: str, candidate_or_value) -> None:
    source = ""
    value = _normalize_value(getattr(candidate_or_value, "value", candidate_or_value))
    segment_id = getattr(candidate_or_value, "segment_id", "")
    start = getattr(candidate_or_value, "start", 0)
    end = getattr(candidate_or_value, "end", 0)
    selected_text = getattr(candidate_or_value, "selected_text", "")
    segment_text = getattr(candidate_or_value, "segment_text", "")
    left_context = getattr(candidate_or_value, "left_context", "")
    right_context = getattr(candidate_or_value, "right_context", "")
    if isinstance(candidate_or_value, dict):
        source = candidate_or_value.get("source", source)
        value = _normalize_value(candidate_or_value.get("value", value))
        segment_id = candidate_or_value.get("segment_id", segment_id)
        start = candidate_or_value.get("start", start)
        end = candidate_or_value.get("end", end)
        selected_text = candidate_or_value.get("selected_text", selected_text)
        segment_text = candidate_or_value.get("segment_text", segment_text)
        left_context = candidate_or_value.get("left_context", left_context)
        right_context = candidate_or_value.get("right_context", right_context)
    store = load_store()
    _deactivate_matching_assignments(
        store,
        template_id,
        field,
        value,
        segment_text,
        left_context,
        right_context,
        source,
    )
    save_store(store)
    save_record({
        "field": field,
        "value": value,
        "template_id": template_id,
        "source": source if field == "quantity" else "",
        "segment_id": segment_id,
        "start": start,
        "end": end,
        "selected_text": selected_text,
        "segment_text": segment_text,
        "left_context": left_context,
        "right_context": right_context,
        "type": "reject",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


def save_anchor(template_id: str, field: str, candidate) -> None:
    save_record({
        "field": field,
        "value": candidate.value,
        "template_id": template_id,
        "segment_id": candidate.segment_id,
        "segment_text": candidate.segment_text,
        "left_context": candidate.left_context,
        "right_context": candidate.right_context,
        "type": "assign",
    })


def load_records(
    template_id: str,
    field: Optional[str] = None,
    record_type: Optional[str] = None,
    source: Optional[str] = None,
) -> List[Dict]:
    records = [_normalize_record(r) for r in load_store().get(template_id, [])]
    if field is not None:
        records = [r for r in records if r["field"] == field]
    if record_type is not None:
        records = [r for r in records if r["type"] == record_type]
    if field == "quantity" and source is not None:
        scoped = [r for r in records if r.get("source", "") == source]
        if scoped:
            records = scoped
        else:
            records = [r for r in records if not r.get("source", "")]
    return records


def load_assignments(template_id: str, field: Optional[str] = None, source: Optional[str] = None):
    records = [
        record
        for record in load_records(template_id, field=field, record_type="assign", source=source)
        if record.get("active", True) and record["value"]
    ]
    if field is not None:
        return records

    assignments: Dict[str, str] = {}
    for record in records:
        assignments[record["field"]] = record["value"]
    return assignments
