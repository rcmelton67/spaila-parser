import json
import os
import sys
from typing import Any, Dict, List, Optional

from .learning.store import CORE_FIELDS, learning_summary, reset_field_learning, save_assignment, save_rejection
from .learning.confidence_store import reset_field, reset_field_everywhere, summarize_fields
from .pipeline import (
    parse_eml,
    build_extraction_signature,
    build_quantity_signature,
    build_price_signature,
    build_shipping_address_signature,
    build_shipping_address_line_learning,
    classify_price_type,
    _price_context_class,
    _price_nearby_label,
    _price_relative_position,
    _price_section_type,
    _shipping_address_pattern_hints,
    _shipping_address_relative_position,
)
from .replay.fingerprint import compute_template_family_id


def _normalize_value(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())


def _serialize_result(result: Dict[str, Any]) -> Dict[str, Any]:
    decisions = [
        {
            "field": decision.field,
            "value": "" if decision.value is None else str(decision.value),
            "decision": decision.decision,
            "decision_source": decision.decision_source,
            "confidence": decision.confidence,
            "signals": decision.provenance.get("signals", []),
            "candidate_id": decision.candidate_id,
            "segment_id": decision.provenance.get("segment_id", ""),
            "snippet": decision.provenance.get("snippet", ""),
            "start": decision.start,
            "end": decision.end,
            "streak_count": decision.provenance.get("streak_count", 0),
        }
        for decision in result["decisions"]
    ]
    segments = [
        {
            "id": segment.id,
            "start": segment.start,
            "end": segment.end,
        }
        for segment in result.get("segments", [])
    ]

    # Count distinct price candidates so the UI can decide whether it is safe
    # to copy the single parser price across multiple items.
    price_candidate_count = sum(
        1 for c in result.get("candidates", []) if c.field_type == "price"
    )
    meta = dict(result.get("meta", {}))
    meta["price_candidate_count"] = price_candidate_count
    # Expose detected platform so the frontend can persist it with the order.
    meta["platform"] = result.get("learning_source", "unknown")

    return {
        "subject": result.get("subject", ""),
        "clean_text": result["clean_text"],
        "decisions": decisions,
        "segments": segments,
        "flags": result.get("flags", {}),
        "meta": meta,
    }


def _find_context(
    result: Dict[str, Any],
    action: Dict[str, Any],
    segment_map: Optional[Dict] = None,
) -> Optional[Dict[str, str]]:
    candidate_id = action.get("candidate_id", "")
    segment_id = action.get("segment_id", "")
    value = action.get("value", "")
    field = action.get("field", "")
    is_manual_assignment = bool(action.get("selected_text")) or action.get("source") == "manual"

    def _buyer_name_value() -> str:
        for decision in result.get("decisions", []):
            if getattr(decision, "field", "") == "buyer_name":
                return getattr(decision, "value", "") or ""
        return ""

    def _candidate_context(candidate) -> Dict[str, Any]:
        if field == "price":
            sig = build_price_signature(candidate, segment_map or {}, result.get("segments", []))
            return {
                "segment_id": candidate.segment_id,
                "start": candidate.start,
                "end": candidate.end,
                "selected_text": candidate.raw_text,
                "segment_text": candidate.segment_text,
                "left_context": candidate.left_context,
                "right_context": candidate.right_context,
                "candidate_id": candidate.id,
                "extractor": candidate.extractor,
                "learned_signature": sig,
                "price_type": classify_price_type(candidate, result.get("segments", [])),
                "section_type": _price_section_type(candidate, result.get("segments", [])),
                "nearby_label": _price_nearby_label(candidate, result.get("segments", [])),
                "context_class": _price_context_class(candidate, result.get("segments", [])),
                "relative_position": _price_relative_position(candidate, result.get("segments", [])),
            }
        if field == "shipping_address":
            sig = build_shipping_address_signature(candidate, segment_map or {})
            lines = [line for line in (candidate.value or "").splitlines() if line.strip()]
            line_learning = {}
            if isinstance(action.get("start"), int) and isinstance(action.get("end"), int):
                line_learning = build_shipping_address_line_learning(
                    candidate,
                    action.get("start"),
                    action.get("end"),
                    _buyer_name_value(),
                )
            return {
                "segment_id": candidate.segment_id,
                "start": candidate.start,
                "end": candidate.end,
                "selected_text": candidate.raw_text,
                "segment_text": candidate.segment_text,
                "left_context": candidate.left_context,
                "right_context": candidate.right_context,
                "candidate_id": candidate.id,
                "extractor": candidate.extractor,
                "learned_signature": sig,
                "relative_position": _shipping_address_relative_position(candidate, result.get("segments", [])),
                "line_count": len(lines),
                "pattern_hints": _shipping_address_pattern_hints(candidate.value),
                **line_learning,
            }
        if segment_map:
            sig = build_extraction_signature(candidate, segment_map)
        else:
            sig = candidate.extractor
        return {
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": sig,
        }

    if action.get("selected_text"):
        start = action.get("start", 0)
        end = action.get("end", 0)
        selected_text = action.get("selected_text", "")
        clean_text = result.get("clean_text", "")
        if is_manual_assignment:
            print(
                "[ASSIGNMENT_BYPASS_GATE] "
                + json.dumps({
                    "field": action.get("field", ""),
                    "start": start,
                    "end": end,
                }),
                file=sys.stderr,
                flush=True,
            )
        if (
            isinstance(start, int)
            and isinstance(end, int)
            and 0 <= start <= end <= len(clean_text)
            and clean_text[start:end] == selected_text
        ):
            print(
                f"[ASSIGNMENT_APPLIED] field={action.get('field', '')!r} value={selected_text!r} start={start} end={end}",
                file=sys.stderr,
                flush=True,
            )
            if field in {"price", "shipping_address"}:
                matched_candidate = next(
                    (
                        c for c in result["candidates"]
                        if (c.field_type == field or (field == "price" and c.extractor == "number_regex"))
                        and (
                            (candidate_id and c.id == candidate_id)
                            or (
                                isinstance(c.start, int)
                                and isinstance(c.end, int)
                                and c.start <= start
                                and end <= c.end
                            )
                        )
                    ),
                    None,
                )
                if matched_candidate is not None:
                    context = _candidate_context(matched_candidate)
                    return {
                        **context,
                        "start": start,
                        "end": end,
                        "selected_text": selected_text,
                    }
            return {
                "segment_id": action.get("segment_id", ""),
                "start": start,
                "end": end,
                "selected_text": selected_text,
                "segment_text": selected_text,
                "left_context": action.get("left_context", ""),
                "right_context": action.get("right_context", ""),
                "candidate_id": action.get("candidate_id", ""),
                "extractor": action.get("extractor", ""),
                "learned_signature": action.get("learned_signature", action.get("extractor", "")),
                "assignment_source": "manual" if is_manual_assignment else "",
            }
        if is_manual_assignment:
            return {
                "segment_id": action.get("segment_id", ""),
                "start": start,
                "end": end,
                "selected_text": selected_text,
                "segment_text": selected_text,
                "left_context": action.get("left_context", ""),
                "right_context": action.get("right_context", ""),
                "candidate_id": action.get("candidate_id", ""),
                "extractor": action.get("extractor", "manual_selection"),
                "learned_signature": action.get("learned_signature", action.get("extractor", "manual_selection")),
                "assignment_source": "manual",
            }
        print(
            f"[ASSIGNMENT_APPLIED] rejected_mismatch field={action.get('field', '')!r} start={start} end={end}",
            file=sys.stderr,
            flush=True,
        )
        return None

    for candidate in result["candidates"]:
        if candidate_id and candidate.id == candidate_id:
            return _candidate_context(candidate)

    for candidate in result["candidates"]:
        if segment_id and candidate.segment_id == segment_id and candidate.value == value:
            return _candidate_context(candidate)

    return None


def _apply_suppression(payload: Dict[str, Any], suppressed_fields: Optional[List[str]] = None) -> Dict[str, Any]:
    suppressed = set(suppressed_fields or [])
    if not suppressed:
        return payload
    filtered = dict(payload)
    filtered["decisions"] = [
        decision for decision in payload["decisions"]
        if decision["field"] not in suppressed
    ]
    return filtered


def parse_file(path: str, suppressed_fields: Optional[List[str]] = None) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"error": "FILE_NOT_FOUND"}
    result = parse_eml(path)
    return _apply_suppression(_serialize_result(result), suppressed_fields)


def apply_learning(action_name: str, path: str, action: Dict[str, Any]) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"success": False, "reason": "FILE_NOT_FOUND", "error": "FILE_NOT_FOUND"}

    # update_confidence=False on BOTH parses here so that accept/reject events
    # never increment streak counters.  Confidence only advances on genuine
    # import parses (parse_file → parse_eml with the default update_confidence=True).
    result = parse_eml(path, update_confidence=False)
    # Use the family ID for all learning operations so that variants of the
    # same platform's email share their learned knowledge.
    template_id = result.get("template_family_id") or compute_template_family_id(result["clean_text"])
    seg_map = result.get("segment_map", {})
    context = _find_context(result, action, seg_map) or {
        "segment_text": "",
        "left_context": "",
        "right_context": "",
    }
    if action.get("selected_text") and not context.get("selected_text"):
        return {
            "success": False,
            "reason": "SELECTION_RANGE_MISMATCH",
            "error": "SELECTION_RANGE_MISMATCH",
        }
    context = {**context, "source": result.get("learning_source", "unknown")}

    field = action["field"]
    value = action.get("selected_text") or action.get("value", "")
    value = "" if value is None else str(value)
    is_manual_assignment = action_name == "save_assignment" and (bool(action.get("selected_text")) or action.get("source") == "manual")

    if action_name == "save_assignment":
        learned_sig = context.get("learned_signature", "")

        if field == "quantity":
            # Re-derive using the stricter context-anchored quantity signature so
            # that the stored record is never a generic cross-platform value.
            _cand_id = context.get("candidate_id", "")
            _qty_cand = next(
                (c for c in result["candidates"] if c.id == _cand_id),
                None,
            )
            if _qty_cand is not None:
                _qty_sig = build_quantity_signature(_qty_cand, seg_map, result["clean_text"])
                if _qty_sig is None:
                    print(
                        f"QUANTITY_SIGNATURE_REJECTED {{ reason: 'too_generic',"
                        f" signature: {learned_sig!r} }}",
                        file=sys.stderr, flush=True,
                    )
                    # Clear learned_signature so the store record carries no
                    # signature — the span-authoritative assignment is still saved.
                    context = {**context, "learned_signature": ""}
                    learned_sig = ""
                else:
                    context = {**context, "learned_signature": _qty_sig}
                    learned_sig = _qty_sig

        print(
            f"SIGNATURE_LEARN {{ field: {field!r}, value: {value!r}, signature: {learned_sig!r} }}",
            file=sys.stderr, flush=True,
        )
        if field == "price":
            print(
                "[PRICE_TYPE_LEARNED] "
                + json.dumps({
                    "price_type": context.get("price_type", ""),
                    "value": value,
                    "signature": learned_sig,
                    "context": {
                        "extractor": context.get("extractor", ""),
                        "nearby_label": context.get("nearby_label", ""),
                        "section_type": context.get("section_type", ""),
                    },
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
        if is_manual_assignment:
            context = {**context, "assignment_source": "manual"}
        save_assignment(template_id, field, value, context)

        # Emit a structured proof log whenever a manual correction is saved so
        # that live debugging can confirm the synthesis path is active.
        if is_manual_assignment:
            print(
                "[CORRECTION_SYNTHESIS] "
                + json.dumps({
                    "field": field,
                    "value": value,
                    "start": context.get("start"),
                    "end": context.get("end"),
                    "source": context.get("source", ""),
                    "role": context.get("role", ""),
                    "role_pattern": context.get("role_pattern", ""),
                    "template_id": template_id,
                    "family_id": result.get("template_family_id", ""),
                    "adaptive_family_id": result.get("adaptive_family_id", ""),
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )

        # Phase 2 — Confidence lifecycle fix:
        # Only reset confidence for quantity (source-scoped, volatile field that
        # must be re-evaluated after each assignment change).  Core structural
        # fields (buyer_name, buyer_email, order_date, ship_by, order_number,
        # price, shipping_address) should NOT have their confidence streak wiped
        # on manual acceptance — that would prevent them from ever reaching
        # autopromotion.  An explicit reset_learning_field call (UI action) is
        # the correct mechanism when the user intentionally clears learning.
        if field == "quantity":
            reset_field(template_id, field, source=result.get("learning_source", "unknown"))
    elif action_name == "save_rejection":
        save_rejection(template_id, field, {
            "value": value,
            **context,
        })
    else:
        raise ValueError(f"Unsupported action: {action_name}")

    # When an address-block assignment carries role information (billing vs
    # shipping source), log the implicit role rule so auditors can confirm the
    # correct block type is being reinforced.
    if action_name == "save_assignment" and is_manual_assignment:
        block_source = context.get("source", "")
        if field in {"shipping_address", "buyer_name"} and block_source:
            print(
                "[ROLE_RULE_WRITTEN] "
                + json.dumps({
                    "field": field,
                    "role": block_source,
                    "rule_scope": template_id,
                    "polarity": "positive",
                    "learned_signature": context.get("learned_signature", ""),
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )

    assignment_lock = None
    if action_name == "save_assignment" and is_manual_assignment:
        assignment_lock = {
            field: {
                "value": value,
                "start": context.get("start"),
                "end": context.get("end"),
                "source": "manual",
            }
        }
    refreshed = parse_eml(path, update_confidence=False, assignment_lock=assignment_lock)
    return _apply_suppression(
        _serialize_result(refreshed),
        action.get("suppressed_fields", []),
    )


def get_learning_summary() -> Dict[str, Any]:
    return {
        "success": True,
        **learning_summary(summarize_fields(CORE_FIELDS)),
    }


def reset_learning_field(field: str) -> Dict[str, Any]:
    reset_result = reset_field_learning(field)
    confidence_removed = reset_field_everywhere(field)
    result = {
        "success": True,
        **reset_result,
        "confidence_removed": confidence_removed,
    }
    print(
        "[FIELD_LEARNING_RESET] "
        + json.dumps({
            "field": field,
            "assignments_removed": reset_result["assignments_removed"],
            "rejections_removed": reset_result["rejections_removed"],
            "confidence_removed": confidence_removed,
        }),
        file=sys.stderr,
        flush=True,
    )
    return result


def _main_json(argv: List[str]) -> Dict[str, Any]:
    if len(argv) < 2:
        raise SystemExit(
            "Usage: py -3 -m parser.ui_bridge '{\"action\":\"parse\",\"path\":\"...\"}'"
        )

    request = json.loads(argv[1])
    command = request["action"]
    if command == "learning_summary":
        return get_learning_summary()
    if command == "reset_field_learning":
        return reset_learning_field(request["field"])
    path = request["path"]
    suppressed_fields = request.get("suppressed_fields", [])

    if command == "parse":
        return parse_file(path, suppressed_fields)
    if command in {"save_assignment", "save_rejection"}:
        return apply_learning(command, path, request["decision"])
    raise SystemExit(f"Unknown action: {command}")


def _main_legacy(argv: List[str]) -> Dict[str, Any]:
    if len(argv) < 3:
        raise SystemExit(
            "Usage: py -3 -m parser.ui_bridge <parse|save_assignment|save_rejection> <path> [json-action]"
        )

    command = argv[1]
    path = argv[2]

    if command == "parse":
        return parse_file(path)
    if command in {"save_assignment", "save_rejection"}:
        if len(argv) < 4:
            raise SystemExit(f"Usage: py -3 -m parser.ui_bridge {command} <path> <json-action>")
        action = json.loads(argv[3])
        return apply_learning(command, path, action)
    raise SystemExit(f"Unknown command: {command}")


def main(argv: List[str]) -> None:
    if len(argv) >= 2 and argv[1].lstrip().startswith("{"):
        payload = _main_json(argv)
    else:
        payload = _main_legacy(argv)

    print(json.dumps(payload))


if __name__ == "__main__":
    main(sys.argv)
