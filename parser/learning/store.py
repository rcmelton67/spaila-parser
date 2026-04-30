import json
import os
import sys
from typing import Dict, List, Optional
from ..order_number_safety import is_safe_order_number_candidate, order_number_safety_reasons
from ..structural_rules import classify_role, structural_signature
from datetime import datetime, timezone

STORE_PATH = "parser/learning/learning_store.json"
CORE_FIELDS = {
    "order_number",
    "shipping_address",
    "buyer_name",
    "buyer_email",
    "price",
    "quantity",
    "order_date",
    "ship_by",
}
TRUST_GLOBAL_TEMPLATE_ID = "__global_structural_trust__"
TRUST_FIELDS = {
    "order_number",
    "buyer_name",
    "buyer_email",
    "shipping_address",
    "order_date",
    "ship_by",
    "quantity",
    "price",
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
        "source_priority_used": record.get("source_priority_used", ""),
        "metadata_fallback_class": record.get("metadata_fallback_class", ""),
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
        "polarity": record.get("polarity", ""),
        "role": record.get("role", ""),
        "structural_signature": record.get("structural_signature", ""),
        "scope": record.get("scope", ""),
        "poison_candidate": record.get("poison_candidate", False),
        "positive_corrections": record.get("positive_corrections", 0),
        "negative_corrections": record.get("negative_corrections", 0),
        "confidence": record.get("confidence", 0.0),
        "demotion_count": record.get("demotion_count", 0),
        "promotion_count": record.get("promotion_count", 0),
        "platform": record.get("platform", ""),
        "adaptive_family": record.get("adaptive_family", record.get("template_id", "")),
        "universality_score": record.get("universality_score", 0.0),
        "trust_score": record.get("trust_score", 0.0),
        "trust_state": record.get("trust_state", "neutral"),
        "quarantined": record.get("quarantined", False),
        "quarantine_reason": record.get("quarantine_reason", ""),
        "last_used_at": record.get("last_used_at", ""),
        "admin_last_touched_at": record.get("admin_last_touched_at", ""),
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
    if record.get("type") == "assign" and record.get("field") == "order_number":
        if not is_safe_order_number_candidate(record, record.get("learned_signature", "")):
            record["active"] = False
            record["quarantined"] = True
            record["quarantine_reason"] = "unsafe_order_number_assignment"
            record["safety_reasons"] = order_number_safety_reasons(
                record, record.get("learned_signature", "")
            )
            print(
                "[ORDER_NUMBER_ASSIGNMENT_QUARANTINED_ON_WRITE] "
                + json.dumps({
                    "value": record.get("value", ""),
                    "signature": record.get("learned_signature", ""),
                    "segment_text": record.get("segment_text", ""),
                    "reasons": record.get("safety_reasons", []),
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
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
        record["poison_candidate"] = True
        record["quarantined"] = True
        record["quarantine_reason"] = "rejected_by_user"
        record["quarantined_at"] = datetime.now(timezone.utc).isoformat()
        print(
            "[POISON_ASSIGNMENT_QUARANTINED] "
            + json.dumps({
                "field": field,
                "value": value,
                "template_id": template_id,
                "signature": record.get("learned_signature", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        print(
            "[SELF_HEAL_APPLIED] "
            + json.dumps({
                "field": field,
                "wrong_value": value,
                "healed": "assignment_quarantined_after_rejection",
                "template_id": template_id,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )


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
        if record.get("type") == "structural_rule":
            continue
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


def _structural_rule_payload(
    template_id: str,
    field: str,
    polarity: str,
    value: str,
    context: Dict,
    scope: str = "global",
) -> Dict:
    candidate_like = {
        "value": value,
        "raw_text": context.get("selected_text") or value,
        "segment_text": context.get("segment_text", ""),
        "left_context": context.get("left_context", ""),
        "right_context": context.get("right_context", ""),
        "extractor": context.get("extractor", ""),
        "learned_signature": context.get("learned_signature", ""),
        "price_type": context.get("price_type", ""),
    }
    role = classify_role(field, candidate_like)
    return {
        "field": field,
        "value": value,
        "template_id": template_id,
        "source": context.get("source", "") if field == "quantity" else "",
        "segment_id": context.get("segment_id", ""),
        "start": context.get("start", 0),
        "end": context.get("end", 0),
        "selected_text": context.get("selected_text", ""),
        "segment_text": context.get("segment_text", ""),
        "left_context": context.get("left_context", ""),
        "right_context": context.get("right_context", ""),
        "candidate_id": context.get("candidate_id", ""),
        "extractor": context.get("extractor", ""),
        "learned_signature": context.get("learned_signature", "") or context.get("extractor", ""),
        "section_type": context.get("section_type", ""),
        "nearby_label": context.get("nearby_label", ""),
        "context_class": context.get("context_class", ""),
        "source_priority_used": context.get("source_priority_used", ""),
        "metadata_fallback_class": context.get("metadata_fallback_class", ""),
        "price_type": context.get("price_type", ""),
        "relative_position": context.get("relative_position", {}) if isinstance(context.get("relative_position", {}), dict) else {},
        "line_count": context.get("line_count", 0),
        "pattern_hints": context.get("pattern_hints", {}) if isinstance(context.get("pattern_hints", {}), dict) else {},
        "type": "structural_rule",
        "polarity": polarity,
        "role": role,
        "structural_signature": structural_signature(field, candidate_like),
        "scope": scope,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def save_structural_rule(
    template_id: str,
    field: str,
    polarity: str,
    value: str,
    context: Dict,
    scope: str = "global",
) -> Dict:
    payload = _structural_rule_payload(template_id, field, polarity, _normalize_value(value), context, scope)
    store = load_store()
    records = store.setdefault(template_id, [])
    for record in records:
        if record.get("type") != "structural_rule":
            continue
        if (
            record.get("field") == payload["field"]
            and record.get("polarity") == payload["polarity"]
            and record.get("role") == payload["role"]
            and record.get("structural_signature") == payload["structural_signature"]
        ):
            record.update(payload)
            save_store(store)
            return record
    records.append(payload)
    save_store(store)
    return payload


def load_structural_rules(
    field: Optional[str] = None,
    polarity: Optional[str] = None,
    template_id: Optional[str] = None,
) -> List[Dict]:
    store = load_store()
    records: List[Dict] = []
    iterable = [(template_id, store.get(template_id, []))] if template_id else store.items()
    for _tid, store_records in iterable:
        for raw in store_records:
            record = _normalize_record(raw)
            if record.get("type") != "structural_rule":
                continue
            if not record.get("active", True):
                continue
            if field and record.get("field") != field:
                continue
            if polarity and record.get("polarity") != polarity:
                continue
            records.append(record)
    return records


def _trust_key(record: Dict) -> tuple:
    return (
        record.get("field", ""),
        record.get("role", ""),
        record.get("structural_signature", ""),
        record.get("source", "") or record.get("platform", ""),
    )


def _trust_payload(template_id: str, field: str, value: str, context: Dict) -> Dict:
    context = context or {}
    candidate_like = {
        "value": value,
        "raw_text": context.get("selected_text") or value,
        "segment_text": context.get("segment_text", ""),
        "left_context": context.get("left_context", ""),
        "right_context": context.get("right_context", ""),
        "extractor": context.get("extractor", ""),
        "learned_signature": context.get("learned_signature", ""),
        "price_type": context.get("price_type", ""),
    }
    source = context.get("source", "") if field == "quantity" else context.get("source", "")
    return {
        "field": field,
        "value": _normalize_value(value),
        "template_id": template_id,
        "source": source,
        "platform": source,
        "adaptive_family": template_id,
        "segment_id": context.get("segment_id", ""),
        "selected_text": context.get("selected_text", ""),
        "segment_text": context.get("segment_text", ""),
        "left_context": context.get("left_context", ""),
        "right_context": context.get("right_context", ""),
        "candidate_id": context.get("candidate_id", ""),
        "extractor": context.get("extractor", ""),
        "learned_signature": context.get("learned_signature", "") or context.get("extractor", ""),
        "section_type": context.get("section_type", ""),
        "nearby_label": context.get("nearby_label", ""),
        "context_class": context.get("context_class", ""),
        "price_type": context.get("price_type", ""),
        "learned_line_types": context.get("learned_line_types", []) if isinstance(context.get("learned_line_types", []), list) else [],
        "excluded_line_types": context.get("excluded_line_types", []) if isinstance(context.get("excluded_line_types", []), list) else [],
        "line_count_pattern": context.get("line_count_pattern", 0),
        "role": context.get("role", "") or classify_role(field, candidate_like),
        "structural_signature": context.get("structural_signature", "") or structural_signature(field, candidate_like),
        "type": "structural_trust",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _recompute_trust_record(record: Dict, all_records: List[Dict]) -> None:
    positives = int(record.get("positive_corrections") or 0)
    negatives = int(record.get("negative_corrections") or 0)
    total = positives + negatives
    record["confidence"] = round(positives / total, 4) if total else 0.0
    record["trust_score"] = round((positives * 1.0) - (negatives * 1.25), 4)
    related_families = {
        item.get("adaptive_family") or item.get("template_id", "")
        for item in all_records
        if item.get("type") == "structural_trust"
        and item.get("field") == record.get("field")
        and item.get("structural_signature") == record.get("structural_signature")
    }
    record["universality_score"] = round(min(1.0, len(related_families) / 5), 4)
    if record.get("quarantined") or negatives >= 3 and negatives > positives:
        record["trust_state"] = "quarantined"
        record["quarantined"] = True
        record["quarantine_reason"] = record.get("quarantine_reason") or "repeated_structural_demotions"
    elif record["trust_score"] >= 1:
        record["trust_state"] = "promoted"
        record["quarantined"] = False
        record["quarantine_reason"] = ""
    elif record["trust_score"] < 0:
        record["trust_state"] = "demoted"
        record["quarantined"] = False
        record["quarantine_reason"] = ""
    else:
        record["trust_state"] = "neutral"
        record["quarantined"] = False
        record["quarantine_reason"] = ""


def update_structural_trust(
    template_id: str,
    field: str,
    value: str,
    context: Dict,
    polarity: str,
) -> Dict:
    if field not in TRUST_FIELDS:
        return {}

    payload = _trust_payload(template_id, field, value, context)
    store = load_store()
    records = store.setdefault(template_id, [])
    existing = None
    for record in records:
        if record.get("type") == "structural_trust" and _trust_key(record) == _trust_key(payload):
            existing = record
            break
    if existing is None:
        existing = payload
        existing["positive_corrections"] = 0
        existing["negative_corrections"] = 0
        existing["promotion_count"] = 0
        existing["demotion_count"] = 0
        records.append(existing)
    else:
        existing.update({k: v for k, v in payload.items() if v not in ("", {}, [])})

    before = existing.get("trust_state", "neutral")
    if polarity == "positive":
        existing["positive_corrections"] = int(existing.get("positive_corrections") or 0) + 1
        existing["promotion_count"] = int(existing.get("promotion_count") or 0) + 1
    else:
        existing["negative_corrections"] = int(existing.get("negative_corrections") or 0) + 1
        existing["demotion_count"] = int(existing.get("demotion_count") or 0) + 1

    all_trust = [
        item
        for store_records in store.values()
        for item in store_records
        if item.get("type") == "structural_trust"
    ]
    _recompute_trust_record(existing, all_trust)

    if polarity == "positive":
        log_name = "[TRUST_PROMOTE]"
    else:
        log_name = "[TRUST_DEMOTE]"
    print(
        log_name + " " + json.dumps({
            "field": field,
            "role": existing.get("role", ""),
            "structural_signature": existing.get("structural_signature", ""),
            "trust_score": existing.get("trust_score", 0.0),
            "trust_state": existing.get("trust_state", ""),
            "adaptive_family": template_id,
            "platform": existing.get("platform", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    if before != existing.get("trust_state"):
        print(
            "[TRUST_SHIFT] " + json.dumps({
                "field": field,
                "from": before,
                "to": existing.get("trust_state", ""),
                "role": existing.get("role", ""),
                "structural_signature": existing.get("structural_signature", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
    if existing.get("trust_state") == "quarantined":
        print(
            "[TRUST_QUARANTINE] " + json.dumps({
                "field": field,
                "role": existing.get("role", ""),
                "structural_signature": existing.get("structural_signature", ""),
                "negative_corrections": existing.get("negative_corrections", 0),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
    save_store(store)
    return _normalize_record(existing)


def load_structural_trust(
    field: Optional[str] = None,
    template_id: Optional[str] = None,
) -> List[Dict]:
    store = load_store()
    records: List[Dict] = []
    for tid, store_records in store.items():
        if template_id and tid not in {template_id, TRUST_GLOBAL_TEMPLATE_ID}:
            continue
        for raw in store_records:
            record = _normalize_record(raw)
            if record.get("type") != "structural_trust":
                continue
            if not record.get("active", True):
                continue
            if field and record.get("field") != field:
                continue
            records.append(record)
    return records


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
    role = getattr(context, "role", "")
    struct_sig = getattr(context, "structural_signature", "")
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
        role = context.get("role", "")
        struct_sig = context.get("structural_signature", "")
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
        "role": role,
        "structural_signature": struct_sig,
        "type": "assign",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store = load_store()
    _self_heal_matching_rejections(store, template_id, payload)
    save_store(store)
    update_structural_trust(template_id, field, value, payload, "positive")
    if field in {"order_number", "price", "buyer_name"}:
        rule = save_structural_rule(template_id, field, "positive", value, payload)
        print(
            "[POSITIVE_RULE_WRITTEN] "
            + json.dumps({
                "field": field,
                "value": value,
                "role": rule.get("role", ""),
                "structural_signature": rule.get("structural_signature", ""),
                "scope": rule.get("scope", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
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
    role = getattr(candidate_or_value, "role", "")
    struct_sig = getattr(candidate_or_value, "structural_signature", "")
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
        role = candidate_or_value.get("role", role)
        struct_sig = candidate_or_value.get("structural_signature", struct_sig)
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
    reject_payload = {
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
        "role": role,
        "structural_signature": struct_sig,
        "type": "reject",
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if field in {"order_number", "price", "buyer_name"}:
        rule = save_structural_rule(template_id, field, "negative", value, reject_payload)
        print(
            "[UNLEARN_STRUCTURAL] "
            + json.dumps({
                "field": field,
                "value": value,
                "role": rule.get("role", ""),
                "structural_signature": rule.get("structural_signature", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        print(
            "[NEGATIVE_RULE_WRITTEN] "
            + json.dumps({
                "field": field,
                "value": value,
                "role": rule.get("role", ""),
                "structural_signature": rule.get("structural_signature", ""),
                "scope": rule.get("scope", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
    update_structural_trust(template_id, field, value, reject_payload, "negative")
    save_record(reject_payload)


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
