import json
import os
import sys
from typing import Any, Dict, List, Optional

from .learning.store import save_assignment, save_rejection
from .pipeline import parse_eml, build_extraction_signature, build_quantity_signature
from .replay.fingerprint import compute_template_family_id


def _serialize_result(result: Dict[str, Any]) -> Dict[str, Any]:
    decisions = [
        {
            "field": decision.field,
            "value": decision.value,
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

    def _sig(candidate) -> str:
        if segment_map:
            return build_extraction_signature(candidate, segment_map)
        return candidate.extractor

    for candidate in result["candidates"]:
        if candidate_id and candidate.id == candidate_id:
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
                "learned_signature": _sig(candidate),
            }

    for candidate in result["candidates"]:
        if segment_id and candidate.segment_id == segment_id and candidate.value == value:
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
                "learned_signature": _sig(candidate),
            }

    if action.get("selected_text"):
        return {
            "segment_id": action.get("segment_id", ""),
            "start": action.get("start", 0),
            "end": action.get("end", 0),
            "selected_text": action.get("selected_text", ""),
            "segment_text": action.get("selected_text", ""),
            "left_context": action.get("left_context", ""),
            "right_context": action.get("right_context", ""),
            "candidate_id": action.get("candidate_id", ""),
            "extractor": action.get("extractor", ""),
            "learned_signature": action.get("learned_signature", action.get("extractor", "")),
        }

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
    context = {**context, "source": result.get("learning_source", "unknown")}

    field = action["field"]
    value = action["value"]

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
        save_assignment(template_id, field, value, context)
    elif action_name == "save_rejection":
        save_rejection(template_id, field, {
            "value": value,
            **context,
        })
    else:
        raise ValueError(f"Unsupported action: {action_name}")

    refreshed = parse_eml(path, update_confidence=False)
    return _apply_suppression(
        _serialize_result(refreshed),
        action.get("suppressed_fields", []),
    )


def _main_json(argv: List[str]) -> Dict[str, Any]:
    if len(argv) < 2:
        raise SystemExit(
            "Usage: py -3 -m parser.ui_bridge '{\"action\":\"parse\",\"path\":\"...\"}'"
        )

    request = json.loads(argv[1])
    command = request["action"]
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
