from parser.learning.store import load_records
from parser.structural_rules import GENERIC_HARD_LOCK_SIGNATURES

ASSIGNED_VALUE_BOOST = 2.5
REJECTED_VALUE_SCORE = -999
REJECTION_THRESHOLD = 0.85


def tokenize(s):
    return set(s.lower().strip().split())


def token_overlap(a, b):
    if not a or not b:
        return 0.0

    ta = tokenize(a)
    tb = tokenize(b)

    if not ta or not tb:
        return 0.0

    return len(ta & tb) / max(len(ta), len(tb))


def compute_anchor_match(candidate, anchor):
    seg_score = token_overlap(candidate.segment_text, anchor["segment_text"])
    left_score = token_overlap(candidate.left_context, anchor["left_context"])
    right_score = token_overlap(candidate.right_context, anchor["right_context"])

    # strong emphasis on segment match
    return (seg_score * 0.7) + (left_score * 0.15) + (right_score * 0.15)


def apply_anchor_scoring(template_id, field, candidates, source=None):
    # Always reset first to prevent cross-field contamination from shared objects
    for c in candidates:
        c.anchor_match = 0.0

    records = load_records(template_id, field=field, source=source)
    if not records:
        return candidates

    assign_records = [r for r in records if r["type"] == "assign" and r.get("active", True)]
    assigned_values = {r["value"] for r in assign_records if r["value"]}
    structural_records = [
        r for r in assign_records
        if not _is_generic_hard_lock_record(r)
        if r["segment_text"] or r["left_context"] or r["right_context"]
    ]
    reject_records = [
        r for r in records
        if r["type"] == "reject"
        and r.get("active", True)
        and (r["segment_text"] or r["left_context"] or r["right_context"])
    ]

    for c in candidates:
        if c.value in assigned_values:
            c.score += ASSIGNED_VALUE_BOOST
            c.signals.append("assigned_value(+2.5)")

        if structural_records:
            c.anchor_match = max(compute_anchor_match(c, record) for record in structural_records)

        if reject_records:
            reject_match = max(compute_anchor_match(c, record) for record in reject_records)
            if reject_match >= REJECTION_THRESHOLD:
                c.score = REJECTED_VALUE_SCORE
                c.penalties.append("rejected_value(−∞)")

    return candidates


def _is_generic_hard_lock_record(record):
    signature = record.get("learned_signature", "") or record.get("signature", "")
    structural = record.get("structural_signature", "")
    return signature in GENERIC_HARD_LOCK_SIGNATURES or structural in GENERIC_HARD_LOCK_SIGNATURES
