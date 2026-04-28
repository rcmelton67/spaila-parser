import json
import os
import sys
from typing import Dict, List, Optional
from datetime import datetime, timezone

STORE_PATH = "parser/learning/learning_store.json"
CORE_FIELDS = {
    "shipping_address",
    "buyer_name",
    "buyer_email",
    "price",
    "quantity",
    "order_date",
    "ship_by",
}


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
        "section_type": record.get("section_type", ""),
        "nearby_label": record.get("nearby_label", ""),
        "context_class": record.get("context_class", ""),
        "price_type": record.get("price_type", ""),
        "relative_position": record.get("relative_position", {}),
        "line_count": record.get("line_count", 0),
        "pattern_hints": record.get("pattern_hints", {}),
        "learned_line_types": record.get("learned_line_types", []),
        "excluded_line_types": record.get("excluded_line_types", []),
        "line_count_pattern": record.get("line_count_pattern", 0),
        "healed_by_assignment": record.get("healed_by_assignment", False),
        "healed_at": record.get("healed_at", ""),
        "assign_count": record.get("assign_count", 0),
        "assignment_source": record.get("assignment_source", ""),
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
        merged["section_type"] = record["section_type"] or merged["section_type"]
        merged["nearby_label"] = record["nearby_label"] or merged["nearby_label"]
        merged["context_class"] = record["context_class"] or merged["context_class"]
        merged["price_type"] = record["price_type"] or merged["price_type"]
        merged["relative_position"] = record["relative_position"] or merged["relative_position"]
        merged["line_count"] = record["line_count"] or merged["line_count"]
        merged["pattern_hints"] = record["pattern_hints"] or merged["pattern_hints"]
        merged["learned_line_types"] = record["learned_line_types"] or merged["learned_line_types"]
        merged["excluded_line_types"] = record["excluded_line_types"] or merged["excluded_line_types"]
        merged["line_count_pattern"] = record["line_count_pattern"] or merged["line_count_pattern"]
        merged["assign_count"] = int(merged.get("assign_count") or 0) + 1
        merged["assignment_source"] = record["assignment_source"] or merged["assignment_source"]
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


def _structural_rejection_match_reason(rejection: Dict, assignment: Dict) -> str:
    """Return why an active rejection matches an assignment, or empty string.

    Manual assignment is authoritative user truth. A matching rejection must be
    healed so it cannot overpower the user's latest correction.
    """
    for key, reason in (
        ("candidate_id", "same_candidate_id"),
        ("learned_signature", "same_learned_signature"),
        ("price_type", "same_price_type"),
        ("segment_id", "same_segment_id"),
    ):
        assigned_value = assignment.get(key)
        rejected_value = rejection.get(key)
        if assigned_value and rejected_value and assigned_value == rejected_value:
            return reason

    # Extractor/section matches are useful for fields whose candidates do not
    # have stable IDs, but they must not wipe unrelated structural learning
    # such as price total vs item price.
    specific_keys = ("learned_signature", "nearby_label", "context_class", "price_type", "segment_id")
    has_specific_conflict = any(
        assignment.get(key)
        and rejection.get(key)
        and assignment.get(key) != rejection.get(key)
        for key in specific_keys
    )
    if has_specific_conflict:
        return ""

    for key, reason in (
        ("extractor", "same_extractor"),
        ("section_type", "same_section_type"),
    ):
        assigned_value = assignment.get(key)
        rejected_value = rejection.get(key)
        if assigned_value and rejected_value and assigned_value == rejected_value:
            return reason
    return ""


def _self_heal_matching_rejections(
    store: Dict[str, List[Dict]],
    template_id: str,
    assignment: Dict,
) -> int:
    field = assignment.get("field", "")
    healed = 0
    healed_at = datetime.now(timezone.utc).isoformat()
    for record in store.get(template_id, []):
        if record.get("type") != "reject":
            continue
        if record.get("field") != field or not record.get("active", True):
            continue
        reason = _structural_rejection_match_reason(record, assignment)
        if not reason:
            continue
        record["active"] = False
        record["healed_by_assignment"] = True
        record["healed_at"] = healed_at
        record["assign_count"] = int(record.get("assign_count") or 0) + 1
        healed += 1
        print(
            "[REJECTION_DEACTIVATED_BY_ASSIGNMENT] "
            + json.dumps({
                "field": field,
                "signature": record.get("learned_signature", "") or record.get("extractor", "") or record.get("candidate_id", ""),
                "match": reason,
            }),
            file=sys.stderr,
            flush=True,
        )
        print(
            "[SELF_HEALING_REJECTION_DEACTIVATED] "
            + json.dumps({
                "field": field,
                "candidate_id": record.get("candidate_id", ""),
                "extractor": record.get("extractor", ""),
                "learned_signature": record.get("learned_signature", ""),
                "reason": "manual_assignment_override",
                "match": reason,
            }),
            file=sys.stderr,
            flush=True,
        )
    return healed


def save_assignment(template_id: str, field: str, value: str, context=None) -> None:
    raw_value = "" if value is None else str(value)
    value = _normalize_value(value)
    source = ""
    segment_id = getattr(context, "segment_id", "")
    start = getattr(context, "start", 0)
    end = getattr(context, "end", 0)
    selected_text = getattr(context, "selected_text", "")
    segment_text = getattr(context, "segment_text", "")
    left_context = getattr(context, "left_context", "")
    right_context = getattr(context, "right_context", "")
    candidate_id = getattr(context, "candidate_id", getattr(context, "id", ""))
    extractor = getattr(context, "extractor", "")
    learned_signature = getattr(context, "learned_signature", "")
    section_type = getattr(context, "section_type", "")
    nearby_label = getattr(context, "nearby_label", "")
    context_class = getattr(context, "context_class", "")
    price_type = getattr(context, "price_type", "")
    relative_position = getattr(context, "relative_position", {})
    line_count = getattr(context, "line_count", 0)
    pattern_hints = getattr(context, "pattern_hints", {})
    learned_line_types = getattr(context, "learned_line_types", [])
    excluded_line_types = getattr(context, "excluded_line_types", [])
    line_count_pattern = getattr(context, "line_count_pattern", 0)
    assignment_source = getattr(context, "assignment_source", "")
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
        section_type = context.get("section_type", "")
        nearby_label = context.get("nearby_label", "")
        context_class = context.get("context_class", "")
        price_type = context.get("price_type", "")
        relative_position = context.get("relative_position", {})
        line_count = context.get("line_count", 0)
        pattern_hints = context.get("pattern_hints", {})
        learned_line_types = context.get("learned_line_types", [])
        excluded_line_types = context.get("excluded_line_types", [])
        line_count_pattern = context.get("line_count_pattern", 0)
        assignment_source = context.get("assignment_source", "")
    selected_text_exact = selected_text if selected_text else raw_value
    payload = {
        "field": field,
        "value": value,
        "template_id": template_id,
        "source": source if field == "quantity" else "",
        "segment_id": segment_id,
        "start": start,
        "end": end,
        "selected_text": selected_text_exact,
        "segment_text": segment_text,
        "left_context": left_context,
        "right_context": right_context,
        "candidate_id": candidate_id,
        "extractor": extractor,
        "learned_signature": learned_signature or extractor,
        "section_type": section_type,
        "nearby_label": nearby_label,
        "context_class": context_class,
        "price_type": price_type,
        "relative_position": relative_position if isinstance(relative_position, dict) else {},
        "line_count": line_count,
        "pattern_hints": pattern_hints if isinstance(pattern_hints, dict) else {},
        "learned_line_types": learned_line_types if isinstance(learned_line_types, list) else [],
        "excluded_line_types": excluded_line_types if isinstance(excluded_line_types, list) else [],
        "line_count_pattern": line_count_pattern,
        "assignment_source": assignment_source,
        "type": "assign",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store = load_store()
    _self_heal_matching_rejections(store, template_id, payload)
    save_store(store)
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
    candidate_id = getattr(candidate_or_value, "candidate_id", getattr(candidate_or_value, "id", ""))
    extractor = getattr(candidate_or_value, "extractor", "")
    learned_signature = getattr(candidate_or_value, "learned_signature", "")
    section_type = getattr(candidate_or_value, "section_type", "")
    nearby_label = getattr(candidate_or_value, "nearby_label", "")
    context_class = getattr(candidate_or_value, "context_class", "")
    price_type = getattr(candidate_or_value, "price_type", "")
    relative_position = getattr(candidate_or_value, "relative_position", {})
    line_count = getattr(candidate_or_value, "line_count", 0)
    pattern_hints = getattr(candidate_or_value, "pattern_hints", {})
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
        candidate_id = candidate_or_value.get("candidate_id", candidate_id)
        extractor = candidate_or_value.get("extractor", extractor)
        learned_signature = candidate_or_value.get("learned_signature", learned_signature)
        section_type = candidate_or_value.get("section_type", section_type)
        nearby_label = candidate_or_value.get("nearby_label", nearby_label)
        context_class = candidate_or_value.get("context_class", context_class)
        price_type = candidate_or_value.get("price_type", price_type)
        relative_position = candidate_or_value.get("relative_position", relative_position)
        line_count = candidate_or_value.get("line_count", line_count)
        pattern_hints = candidate_or_value.get("pattern_hints", pattern_hints)
    store = load_store()
    if field != "shipping_address":
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
        "candidate_id": candidate_id,
        "extractor": extractor,
        "learned_signature": learned_signature or extractor,
        "section_type": section_type,
        "nearby_label": nearby_label,
        "context_class": context_class,
        "price_type": price_type,
        "relative_position": relative_position if isinstance(relative_position, dict) else {},
        "line_count": line_count,
        "pattern_hints": pattern_hints if isinstance(pattern_hints, dict) else {},
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
    # Manual assignment is authoritative user truth. When callers load mixed
    # learning records, active assignments are presented before rejection
    # records so conflict resolution naturally favors the user's correction.
    records.sort(key=lambda r: (
        0 if r.get("active", True) and r.get("type") == "assign" else 1,
        0 if r.get("active", True) else 1,
    ))
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


def load_shipping_address_line_type_assignments(
    template_id: str,
    source: str = "",
) -> List[Dict]:
    """Load active shipping line-type learning for the current template.

    Falls back to cross-template records only when no same-template records
    exist, but restricts the fallback by source (platform) so that Etsy
    patterns never bleed into WooCommerce templates and vice versa.  When
    source is empty/unknown the fallback is unrestricted (preserving backward
    compatibility for templates without an explicit platform tag).
    """
    local_records = [
        record for record in load_assignments(template_id, "shipping_address")
        if record.get("learned_line_types")
    ]
    if local_records:
        if source:
            source_matched = [r for r in local_records if r.get("source", "") in {"", source}]
            if source_matched:
                return source_matched
        return local_records

    # Fallback: search all templates, restricted by source when available.
    records: List[Dict] = []
    for store_records in load_store().values():
        for raw_record in store_records:
            record = _normalize_record(raw_record)
            if record.get("field") != "shipping_address":
                continue
            if record.get("type") != "assign" or not record.get("active", True):
                continue
            if not record.get("learned_line_types"):
                continue
            if source and record.get("source", "") not in {"", source}:
                continue
            records.append(record)
    return records


def learning_summary(confidence_summary: Optional[Dict[str, Dict]] = None) -> Dict:
    store = load_store()
    fields = {field: {
        "field": field,
        "assignments": 0,
        "active_rejections": 0,
        "confidence": (confidence_summary or {}).get(field, {}),
    } for field in sorted(CORE_FIELDS)}
    for records in store.values():
        for record in records:
            field = record.get("field", "")
            if field not in fields:
                continue
            if record.get("type") == "assign" and record.get("active", True):
                fields[field]["assignments"] += 1
            elif record.get("type") == "reject" and record.get("active", True):
                fields[field]["active_rejections"] += 1
    return {"fields": [fields[field] for field in sorted(fields)]}


def reset_field_learning(field: str) -> Dict:
    if field not in CORE_FIELDS:
        raise ValueError(f"Unsupported learning field: {field}")
    store = load_store()
    assignments_removed = 0
    rejections_removed = 0
    for template_id, records in list(store.items()):
        kept = []
        for record in records:
            if record.get("field") != field:
                kept.append(record)
                continue
            if record.get("type") == "assign":
                assignments_removed += 1
            elif record.get("type") == "reject":
                rejections_removed += 1
            # Removing field records is intentionally scoped to this field only.
        store[template_id] = kept
    save_store(store)
    return {
        "field": field,
        "assignments_removed": assignments_removed,
        "rejections_removed": rejections_removed,
    }
