from typing import List, Dict, Any, Optional as _Opt
import re
import sys
from difflib import SequenceMatcher
from .ingest import load_eml
from .sanitize import sanitize
from .segment import segment
from .extract import (
    extract_numbers,
    extract_dates,
    extract_header_date,
    extract_emails,
    extract_ship_by_from_subject,
    extract_ship_by_from_body,
    extract_buyer_name,
    extract_shipping_address,
    validate_candidates,
)
from .score import (
    score_quantity,
    score_price,
    score_order_number,
    score_order_date,
    score_buyer_email,
    score_ship_by,
    score_buyer_name,
    score_shipping_address,
)
from .decide import (
    decide_quantity,
    decide_price,
    decide_order_number,
    decide_order_date,
    decide_buyer_email,
    decide_ship_by,
    decide_buyer_name,
    decide_shipping_address,
)
from .models import Candidate, DecisionRow
from .replay.fingerprint import compute_template_id, compute_template_family_id, normalize_for_family, normalize_for_family
from .replay.load import load_replay
from .anchors.match import apply_anchor_scoring, compute_anchor_match
from .learning.store import load_assignments, load_records
from .learning.confidence_store import update_streak, get_currently_promoted_fields

ENABLE_REPLAY = True
_GIFT_STRONG_WORDS = (
    "marked as gift",
    "this order is a gift",
    "gift details",
    "gift order",
)
_GIFT_MEDIUM_WORDS = ("gift message", "customer note", "message:")
_PERSONALIZATION_WORDS = ("pet name", "heading", "engraving", "custom text")
_MESSAGE_LABELS = ("customer note", "gift message")

OVERRIDE_THRESHOLDS = {
    "price": 0.85,
    "quantity": 0.95,
    "order_number": 0.3,
    "order_date": 0.2,
    "buyer_email": 0.6,
    "ship_by": 0.8,
}


_ALL_FIELDS = (
    "quantity", "price", "order_number", "order_date",
    "buyer_email", "ship_by", "buyer_name", "shipping_address",
)
_STRICT_ASSIGNED_FIELDS = {"quantity"}

# Minimum context-similarity score required to accept a context-disambiguated
# match.  Kept low so that same-template emails (same labels, different values)
# still match; raised enough to reject completely unrelated occurrences.
_CONTEXT_MATCH_THRESHOLD = 0.15

# Context window (chars) used when comparing stored vs actual surroundings.
# Must match _attach_context's window in extract.py (currently 10 chars).
_CTX_WINDOW = 10

# ── Extraction-signature construction ─────────────────────────────────────────

# Ordered list of (role, keywords) — first match wins.
_ROLE_SIGNALS: list = [
    ("shipping", ("ship to", "shipping address", "shipping", "deliver", "postal")),
    ("header",   ("from:", "date:", "subject:", "to:")),
    ("pricing",  ("price", "total", "amount", "subtotal")),
    ("order",    ("order #", "order no", "order number", "purchase")),
    ("buyer",    ("buyer", "customer", "seller")),
]

# Patterns whose first match in the segment text becomes the label key.
_LABEL_RE = re.compile(
    r"order\s*(?:#|no\.?|num(?:ber)?)"
    r"|ship\s*by"
    r"|ship(?:ping)?\s*(?:to|address|date)"
    r"|order\s*date"
    r"|total|amount|price|subtotal"
    r"|quantity|qty"
    r"|buyer|customer|e-?mail"
    r"|from|subject",
    re.IGNORECASE,
)


def _infer_segment_role(text: str) -> str:
    """Return a coarse role label for a segment line."""
    lower = text.lower()
    for role, keywords in _ROLE_SIGNALS:
        if any(kw in lower for kw in keywords):
            return role
    return "body"


def _infer_label_key(candidate) -> str:
    """Return a normalised label token extracted from the candidate's segment context."""
    search_text = (candidate.segment_text or "") + " " + (candidate.left_context or "")
    m = _LABEL_RE.search(search_text)
    if m:
        return re.sub(r"[^a-z0-9]+", "_", m.group().strip().lower()).strip("_")
    return "none"


def build_extraction_signature(candidate, segment_map: Dict) -> str:
    """Build a structured extraction signature for *candidate*.

    Primary format (used for matching and confidence keys):
        "{extractor}|{label_key}|{segment_role}"

    segment_index is intentionally excluded from the primary signature so that
    slight layout shifts between emails (different line numbers) do not prevent
    confidence from building.  The segment object is still resolved here for
    use by callers that want the index as a secondary / debug signal.
    """
    seg = segment_map.get(candidate.segment_id) if candidate.segment_id else None
    seg_role = _infer_segment_role(candidate.segment_text or (seg.text if seg else ""))
    label_key = _infer_label_key(candidate)
    extractor = candidate.extractor or "unknown"
    return f"{extractor}|{label_key}|{seg_role}"


# ── Quantity-specific signature (stricter, context-anchored) ──────────────────

# Ordered list of (pattern, anchor_label).  First match in the ±50-char window
# wins.  Anchors are deliberately platform-specific so Etsy and Woo signatures
# never collide on the generic "number_regex|none|body" fallback.
_QUANTITY_BLOCK_SIGNALS: list = [
    (re.compile(r"\b(?:qty|quantity|item\s*count|how\s*many|number\s+of\s+items?)\b", re.IGNORECASE), "qty_label"),
    (re.compile(r"\bline\s*item\b", re.IGNORECASE), "line_item"),
    (re.compile(r"\bshopping\s*cart\b|\bcart\b", re.IGNORECASE), "cart_block"),
    (re.compile(r"\border\s*summary\b|\bsubtotal\b|\btotal\b", re.IGNORECASE), "order_summary"),
    (re.compile(r"\bproduct\b|\bsku\b|\blisting\b", re.IGNORECASE), "product_block"),
    (re.compile(r"\bship(?:ping)?\b|\bdeliver\b", re.IGNORECASE), "shipping_block"),
    (re.compile(r"\bpurchase\b|\border\b", re.IGNORECASE), "order_block"),
]

# Signatures that are too generic to be useful — must NOT be stored as
# learned_signature for quantity and must NOT count toward confidence streaks.
_GENERIC_QUANTITY_SIGS: frozenset = frozenset({
    "number_regex|none|body",
    "number_regex|none|order",
    "number_regex|none|header",
    "number_regex|none|shipping",
    "number_regex|none|pricing",
    "number_regex|none|buyer",
})


def _detect_learning_source(ingested: Dict[str, Any], clean_text: str) -> str:
    subject = (ingested.get("subject") or "").lower()
    body = clean_text.lower()
    if "etsy" in subject or "etsy" in body:
        return "etsy"
    if (
        "melton memorials" in subject
        or "you've got a new order" in subject
        or "woocommerce" in body
    ):
        return "woo"
    return "unknown"


def _quantity_learning_key(template_id: str, signature: str, source: str) -> str:
    return f"{template_id}:quantity:{signature}:{source}"


def _derive_quantity_context_anchor(candidate, clean_text: str) -> str:
    """Return a platform-specific context anchor for a quantity candidate.

    Scans ±50 chars of *clean_text* around the candidate's position.  Falls
    back to the raw segment text when the position is unavailable.  Returns
    an empty string when no recognisable structure is found.
    """
    seg_text = candidate.segment_text or ""
    if candidate.start is not None and clean_text:
        lo = max(0, candidate.start - 50)
        hi = min(len(clean_text), (candidate.end or candidate.start) + 50)
        wider = clean_text[lo:hi]
    else:
        wider = seg_text

    for pattern, anchor in _QUANTITY_BLOCK_SIGNALS:
        if pattern.search(wider):
            return anchor
    return ""


def build_quantity_signature(candidate, segment_map: Dict, clean_text: str) -> _Opt[str]:
    """Build an enriched, platform-specific signature for a quantity candidate.

    Format: "{extractor}|{label_key}|{context_anchor}"

    Returns *None* when the derived signature is too generic (i.e. it appears
    in *_GENERIC_QUANTITY_SIGS* or has no label and no context anchor).
    Callers that receive *None* MUST NOT store a learned_signature and MUST NOT
    update confidence streaks for that parse.
    """
    extractor = candidate.extractor or "unknown"
    label_key = _infer_label_key(candidate)
    context_anchor = _derive_quantity_context_anchor(candidate, clean_text)

    if context_anchor:
        sig = f"{extractor}|{label_key}|{context_anchor}"
    else:
        seg = segment_map.get(candidate.segment_id) if candidate.segment_id else None
        role = _infer_segment_role(candidate.segment_text or (seg.text if seg else ""))
        sig = f"{extractor}|{label_key}|{role}"

    if sig in _GENERIC_QUANTITY_SIGS or (label_key == "none" and not context_anchor):
        return None
    return sig


def _apply_signature_scoring(
    candidates: List,
    template_id: str,
    field: str,
    segment_map: Dict,
    clean_text: str = "",
    source: str | None = None,
) -> List:
    """Boost candidate scores when they match a previously learned extraction signature.

    Exact match  (extractor + label_key + context/role all match) → +10
    Partial match (extractor + context/role match, label differs) → +6

    For *quantity* the richer `build_quantity_signature` is used; candidates
    that yield a None (too generic) signature receive no boost.

    This is purely additive — existing scores and signals are never removed.
    """
    from .learning.store import load_records  # local import avoids circular dependency
    records = load_records(template_id, field=field, record_type="assign", source=source)
    if not records:
        return candidates

    learned_sigs = {r["learned_signature"] for r in records if r.get("learned_signature")}
    if not learned_sigs:
        return candidates

    # Pre-compute extractor+role/anchor pairs for partial matching (parts 0 and 2).
    learned_ext_anchor = {
        f"{sig.split('|')[0]}|{sig.split('|')[2]}"
        for sig in learned_sigs
        if len(sig.split("|")) >= 3
    }

    for candidate in candidates:
        if field == "quantity":
            sig = build_quantity_signature(candidate, segment_map, clean_text)
            if sig is None:
                continue  # too generic — no boost
        else:
            sig = build_extraction_signature(candidate, segment_map)

        parts = sig.split("|")
        if sig in learned_sigs:
            candidate.score += 10.0
            candidate.signals.append("sig_exact_match(+10)")
        elif len(parts) >= 3 and f"{parts[0]}|{parts[2]}" in learned_ext_anchor:
            candidate.score += 6.0
            candidate.signals.append("sig_partial_match(+6)")

    return candidates


def _load_assigned_fields(template_id: str, quantity_source: str = "") -> Dict[str, bool]:
    """Return a mapping field -> True for every field that has an active assignment."""
    assigned = {}
    for field in _ALL_FIELDS:
        source = quantity_source if field == "quantity" else None
        assigned[field] = bool(load_assignments(template_id, field, source=source))
    return assigned


def _ctx_sim(a: str, b: str) -> float:
    """Normalized similarity in [0, 1] between two short context strings."""
    a = a.strip().lower()
    b = b.strip().lower()
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _score_position(pos: int, val_len: int, clean_text: str, record: Dict) -> float:
    """Score a candidate position in clean_text by comparing stored context."""
    actual_left = clean_text[max(0, pos - _CTX_WINDOW):pos]
    actual_right = clean_text[pos + val_len: pos + val_len + _CTX_WINDOW]

    stored_left = record.get("left_context") or ""
    stored_right = record.get("right_context") or ""
    stored_seg = record.get("segment_text") or ""

    left_sim = _ctx_sim(actual_left, stored_left)
    right_sim = _ctx_sim(actual_right, stored_right)

    scores: List[float] = [left_sim, right_sim]

    if stored_seg:
        # Compare the full line in clean_text that contains this position.
        line_start = clean_text.rfind("\n", 0, pos) + 1
        line_end_raw = clean_text.find("\n", pos)
        line_end = line_end_raw if line_end_raw != -1 else len(clean_text)
        actual_seg = clean_text[line_start:line_end]
        scores.append(_ctx_sim(actual_seg, stored_seg))

    return sum(scores) / len(scores)


def _resolve_positions(
    positions: List[int],
    val_len: int,
    clean_text: str,
    record: Dict,
) -> _Opt[int]:
    """Return the best-matching position from a list of candidates.

    With a single position, returns it unconditionally.
    With multiple positions, uses context similarity to pick the best one;
    returns None only when no position reaches _CONTEXT_MATCH_THRESHOLD.
    """
    if not positions:
        return None
    if len(positions) == 1:
        return positions[0]

    best_pos: _Opt[int] = None
    best_score = -1.0
    for pos in positions:
        score = _score_position(pos, val_len, clean_text, record)
        if score > best_score:
            best_score = score
            best_pos = pos

    return best_pos if best_score >= _CONTEXT_MATCH_THRESHOLD else None


def _inject_assigned_candidates(
    template_id: str,
    field: str,
    candidates: List,
    segments: List,
    clean_text: str,
    source: str | None = None,
) -> List:
    """Span-authoritative injection.

    If an active assignment exists for *field*:
      - Resolve the stored span in *clean_text*, using context similarity to
        disambiguate when the value appears multiple times.
      - Return a single-element list containing only that candidate; all
        score-based candidates are discarded so the assigned span wins
        unconditionally.
      - Return [] only when no match reaches _CONTEXT_MATCH_THRESHOLD.

    If no assignment exists, return *candidates* unchanged.
    """
    assigned_records = load_assignments(template_id, field, source=source)
    if not assigned_records:
        return candidates

    if field == "quantity":
        best_candidate = None
        best_score = -1.0
        best_record = None
        trace_rows = []

        for record in assigned_records:
            learned_signature = record.get("learned_signature") or record.get("extractor") or "UNKNOWN"
            for candidate in candidates:
                structural_score = compute_anchor_match(candidate, record)
                extractor_bonus = 0.0
                if record.get("extractor") and candidate.extractor == record.get("extractor"):
                    extractor_bonus = 0.2
                total_score = structural_score + extractor_bonus
                trace_rows.append({
                    "candidate_id": candidate.id,
                    "value": candidate.value,
                    "start": candidate.start,
                    "end": candidate.end,
                    "extractor": candidate.extractor,
                    "structural_score": round(structural_score, 4),
                    "extractor_bonus": round(extractor_bonus, 4),
                    "total_score": round(total_score, 4),
                })
                if total_score > best_score:
                    best_score = total_score
                    best_candidate = candidate
                    best_record = record

        selected_payload = None
        reason = "no_structural_match"
        if best_candidate is not None and best_score >= 0.5:
            reason = "learned_location_match"
            selected_payload = {
                "candidate_id": best_candidate.id,
                "value": best_candidate.value,
                "start": best_candidate.start,
                "end": best_candidate.end,
                "extractor": best_candidate.extractor,
                "score": round(best_score, 4),
            }

        print(
            f"QUANTITY_REPLAY_TRACE {{ learned_signature: {(best_record or assigned_records[0]).get('learned_signature') or (best_record or assigned_records[0]).get('extractor') or 'UNKNOWN'},"
            f" candidates_found: {trace_rows}, selected_candidate: {selected_payload}, reason: {reason} }}",
            file=sys.stderr,
            flush=True,
        )

        if selected_payload is None:
            return []

        return [Candidate(
            id=f"learned_{field}_0001",
            field_type=field,
            value=best_candidate.value,
            raw_text=best_candidate.raw_text,
            start=best_candidate.start,
            end=best_candidate.end,
            segment_id=best_candidate.segment_id,
            extractor=best_candidate.extractor,
            signals=["assigned_structure(authoritative)", "learned_location_match"],
            penalties=[],
            score=999,
            segment_text=best_candidate.segment_text,
            left_context=best_candidate.left_context,
            right_context=best_candidate.right_context,
            source="learned",
        )]

    segment_map = {seg.id: seg for seg in segments}

    for i, record in enumerate(assigned_records):
        value = record["value"]
        segment_id = record.get("segment_id", "")

        original_start = record.get("start")  # may be None for header/subject candidates
        original_end = record.get("end")

        # Out-of-body candidates (header date, subject ship_by) are stored with
        # start=None / end=None because they have no position in clean_text.
        # Preserve them as-is — a position-less DecisionRow is valid.
        if original_start is None:
            raw_text = record.get("selected_text", "") or value
            segment_text = record.get("segment_text", "") or raw_text
            return [Candidate(
                id=f"learned_{field}_{i+1:04d}",
                field_type=field,
                value=value,
                raw_text=raw_text,
                start=None,
                end=None,
                segment_id=segment_id,
                extractor="learning",
                signals=["assigned_span(authoritative)"],
                penalties=[],
                score=999,
                segment_text=segment_text,
                left_context=record.get("left_context", ""),
                right_context=record.get("right_context", ""),
                source="learned",
            )]

        segment_obj = segment_map.get(segment_id)

        stored_start = original_start or 0
        stored_end = original_end or 0
        val_len = len(value)

        # ── Resolution priority ──────────────────────────────────────────────

        # 1. Stored offsets are still valid — fastest path, no search needed.
        if stored_start and stored_end and clean_text[stored_start:stored_end] == value:
            start, end = stored_start, stored_end

        # 2. Multi-line value — must search full text; segments can't contain it.
        elif "\n" in value:
            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
            resolved = _resolve_positions(positions, val_len, clean_text, record)
            if resolved is None:
                continue
            start, end = resolved, resolved + val_len

        # 3. Single-line, original segment still exists — try segment-scoped
        #    search first to reduce false positives, then fall back to full text.
        elif segment_obj:
            seg_text = segment_obj.text
            first = seg_text.find(value)
            if first != -1 and seg_text.find(value, first + 1) == -1:
                # Unique within original segment — use it directly.
                start = segment_obj.start + first
                end = start + val_len
            else:
                # Absent or ambiguous in original segment — search full text.
                positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
                resolved = _resolve_positions(positions, val_len, clean_text, record)
                if resolved is None:
                    continue
                start, end = resolved, resolved + val_len

        # 4. No segment hint — search full clean_text with context scoring.
        else:
            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
            resolved = _resolve_positions(positions, val_len, clean_text, record)
            if resolved is None:
                continue
            start, end = resolved, resolved + val_len

        raw_text = record.get("selected_text", "") or value
        segment_text = record.get("segment_text", "") or raw_text

        # Span resolved — return it as the sole authoritative candidate.
        return [Candidate(
            id=f"learned_{field}_{i+1:04d}",
            field_type=field,
            value=value,
            raw_text=raw_text,
            start=start,
            end=end,
            segment_id=segment_id,
            extractor="learning",
            signals=["assigned_span(authoritative)"],
            penalties=[],
            score=999,
            segment_text=segment_text,
            left_context=record.get("left_context", ""),
            right_context=record.get("right_context", ""),
            source="learned",
        )]

    # Assignment exists but no position reached the confidence threshold.
    return []


def _field_is_rejected(template_id: str, field: str, source: str | None = None) -> bool:
    records = load_records(template_id, field=field, record_type="reject", source=source)
    return any(record.get("active", True) for record in records)


def _apply_assignment_policy(
    template_id: str,
    field: str,
    candidates: List,
    segments: List,
    clean_text: str,
    source: str | None = None,
) -> tuple[List, bool]:
    """Return candidates plus whether the field remains assignment-locked.

    Non-strict fields fall back to the normal scoring/replay path when an
    active assignment exists but its stored span no longer resolves.
    """
    if not load_assignments(template_id, field, source=source):
        return candidates, False

    assigned_candidates = _inject_assigned_candidates(
        template_id,
        field,
        candidates,
        segments,
        clean_text,
        source,
    )
    if assigned_candidates:
        return assigned_candidates, True

    if field in _STRICT_ASSIGNED_FIELDS:
        print(
            f"[LEARNING] ASSIGNED FAILED -> STRICT EMPTY for field: {field}",
            file=sys.stderr,
            flush=True,
        )
        return [], True

    print(
        f"[LEARNING] ASSIGNED FAILED -> FALLBACK USED for field: {field}",
        file=sys.stderr,
        flush=True,
    )
    return candidates, False


def parse_eml(path: str, update_confidence: bool = True) -> Dict[str, Any]:
    ingested = load_eml(path)
    clean_text = sanitize(ingested)
    learning_source = _detect_learning_source(ingested, clean_text)

    template_id = compute_template_id(clean_text)
    template_family_id = compute_template_family_id(clean_text)
    normalized_family_preview = normalize_for_family(clean_text)[:300]

    # Replay and all learning operations use the family ID so that variants of
    # the same platform's email share their learned knowledge.
    replay_data = load_replay(template_family_id)

    segments = segment(clean_text)

    # Segment lookup used by signature construction and injection helpers.
    segment_map: Dict[str, Any] = {seg.id: seg for seg in segments}

    # Pre-load all field assignments once so we can bypass anchor scoring for
    # fields the user has already pinned.  Each call hits the JSON store, so
    # batching avoids N redundant reads inside _inject_assigned_candidates.
    af = _load_assigned_fields(template_family_id, quantity_source=learning_source)
    _total_assign = sum(1 for v in af.values() if v)
    print(f"[LEARNING] template={template_id[:12]}  family={template_family_id[:12]}  ASSIGN RECORDS FOUND: {_total_assign}", file=sys.stderr, flush=True)

    # Extract base number candidates and validate contract immediately
    candidates = validate_candidates(extract_numbers(segments), clean_text)

    # --- QUANTITY ---
    assignment_locked: Dict[str, bool] = {}

    quantity_candidates = score_quantity(candidates, segments)
    quantity_candidates, assignment_locked["quantity"] = _apply_assignment_policy(
        template_family_id, "quantity", quantity_candidates, segments, clean_text, learning_source
    )
    if not assignment_locked["quantity"]:
        quantity_candidates = apply_anchor_scoring(template_family_id, "quantity", quantity_candidates, source=learning_source)
        quantity_candidates = _apply_signature_scoring(
            quantity_candidates, template_family_id, "quantity", segment_map, clean_text, source=learning_source
        )
    quantity_decision = None if _field_is_rejected(template_family_id, "quantity", source=learning_source) else decide_quantity(quantity_candidates)

    # --- PRICE ---
    price_candidates = score_price(candidates, segments, quantity_candidates)
    price_candidates, assignment_locked["price"] = _apply_assignment_policy(
        template_family_id, "price", price_candidates, segments, clean_text
    )
    if not assignment_locked["price"]:
        price_candidates = apply_anchor_scoring(template_family_id, "price", price_candidates)
        price_candidates = _apply_signature_scoring(price_candidates, template_family_id, "price", segment_map)
    price_decision = None if _field_is_rejected(template_family_id, "price") else decide_price(price_candidates)

    # --- ORDER NUMBER ---
    order_candidates = score_order_number(candidates, segments)
    order_candidates, assignment_locked["order_number"] = _apply_assignment_policy(
        template_family_id, "order_number", order_candidates, segments, clean_text
    )
    if not assignment_locked["order_number"]:
        order_candidates = apply_anchor_scoring(template_family_id, "order_number", order_candidates)
        order_candidates = _apply_signature_scoring(order_candidates, template_family_id, "order_number", segment_map)
    order_decision = None if _field_is_rejected(template_family_id, "order_number") else decide_order_number(order_candidates)

    # Log template family mapping for debugging cross-email learning.
    _order_num_for_log = order_decision.value if order_decision else "unknown"
    _family_normalized_preview = normalize_for_family(clean_text)
    print(
        f"TEMPLATE_FAMILY_DEBUG {{"
        f" order_number: {_order_num_for_log!r},"
        f" template_id: {template_id[:12]!r},"
        f" template_family_id: {template_family_id[:12]!r} }}",
        file=sys.stderr, flush=True,
    )
    print(
        f"TEMPLATE_NORMALIZATION_DEBUG {{"
        f" order_number: {_order_num_for_log!r},"
        f" template_family_id: {template_family_id[:12]!r},"
        f" normalized_preview: {_family_normalized_preview[:300]!r} }}",
        file=sys.stderr, flush=True,
    )
    print(
        f"TEMPLATE_NORMALIZATION_DEBUG {{ order_number: {_order_num_for_log!r},"
        f" template_family_id: {template_family_id!r},"
        f" normalized_preview_first_300_chars: {normalized_family_preview!r} }}",
        file=sys.stderr,
        flush=True,
    )
    _qty_records_for_scope = load_assignments(template_family_id, "quantity", source=learning_source)
    _qty_sig_for_scope = None
    if _qty_records_for_scope:
        _qty_sig_for_scope = (
            _qty_records_for_scope[0].get("learned_signature")
            or _qty_records_for_scope[0].get("extractor")
            or "UNKNOWN"
        )
    print(
        f"LEARNING_SCOPE_CHECK {{ order_number: {_order_num_for_log!r},"
        f" source: {learning_source!r},"
        f" learning_key_used: {_quantity_learning_key(template_family_id, _qty_sig_for_scope or 'NONE', learning_source)!r},"
        f" learned_signature: {_qty_sig_for_scope!r} }}",
        file=sys.stderr,
        flush=True,
    )

    # --- ORDER DATE ---
    # Body dates validated; header dates have start=None/end=None and pass through
    date_candidates = validate_candidates(extract_dates(segments), clean_text)
    date_candidates += extract_header_date(ingested.get("email_date", ""))
    date_candidates = score_order_date(date_candidates, segments)
    date_candidates, assignment_locked["order_date"] = _apply_assignment_policy(
        template_family_id, "order_date", date_candidates, segments, clean_text
    )
    if not assignment_locked["order_date"]:
        date_candidates = apply_anchor_scoring(template_family_id, "order_date", date_candidates)
        date_candidates = _apply_signature_scoring(date_candidates, template_family_id, "order_date", segment_map)
    date_decision = None if _field_is_rejected(template_family_id, "order_date") else decide_order_date(date_candidates)

    # --- BUYER EMAIL ---
    email_candidates = validate_candidates(extract_emails(segments), clean_text)
    email_candidates = score_buyer_email(email_candidates, segments)
    email_candidates, assignment_locked["buyer_email"] = _apply_assignment_policy(
        template_family_id, "buyer_email", email_candidates, segments, clean_text
    )
    if not assignment_locked["buyer_email"]:
        email_candidates = apply_anchor_scoring(template_family_id, "buyer_email", email_candidates)
        email_candidates = _apply_signature_scoring(email_candidates, template_family_id, "buyer_email", segment_map)
    email_decision = None if _field_is_rejected(template_family_id, "buyer_email") else decide_buyer_email(email_candidates)

    # --- SHIP BY ---
    # Subject candidates have start=None/end=None; body candidates are validated
    ship_by_candidates = extract_ship_by_from_subject(ingested.get("subject", ""))
    ship_by_candidates += validate_candidates(extract_ship_by_from_body(segments), clean_text)
    ship_by_candidates = score_ship_by(
        ship_by_candidates,
        segments,
        price_candidates,
        order_candidates,
        subject=ingested.get("subject", ""),
    )
    ship_by_candidates, assignment_locked["ship_by"] = _apply_assignment_policy(
        template_family_id, "ship_by", ship_by_candidates, segments, clean_text
    )
    if not assignment_locked["ship_by"]:
        ship_by_candidates = apply_anchor_scoring(template_family_id, "ship_by", ship_by_candidates)
        ship_by_candidates = _apply_signature_scoring(ship_by_candidates, template_family_id, "ship_by", segment_map)
    ship_by_decision = None if _field_is_rejected(template_family_id, "ship_by") else decide_ship_by(ship_by_candidates)

    # --- BUYER NAME ---
    name_candidates = validate_candidates(extract_buyer_name(segments), clean_text)
    name_candidates = score_buyer_name(name_candidates, segments)
    name_candidates, assignment_locked["buyer_name"] = _apply_assignment_policy(
        template_family_id, "buyer_name", name_candidates, segments, clean_text
    )
    if not assignment_locked["buyer_name"]:
        name_candidates = apply_anchor_scoring(template_family_id, "buyer_name", name_candidates)
        name_candidates = _apply_signature_scoring(name_candidates, template_family_id, "buyer_name", segment_map)
    name_decision = None if _field_is_rejected(template_family_id, "buyer_name") else decide_buyer_name(name_candidates)

    # --- SHIPPING ADDRESS ---
    addr_candidates = validate_candidates(extract_shipping_address(segments), clean_text)
    addr_candidates = score_shipping_address(addr_candidates, segments)
    addr_candidates, assignment_locked["shipping_address"] = _apply_assignment_policy(
        template_family_id, "shipping_address", addr_candidates, segments, clean_text
    )
    if not assignment_locked["shipping_address"]:
        addr_candidates = apply_anchor_scoring(template_family_id, "shipping_address", addr_candidates)
        addr_candidates = _apply_signature_scoring(addr_candidates, template_family_id, "shipping_address", segment_map)
    addr_decision = None if _field_is_rejected(template_family_id, "shipping_address") else decide_shipping_address(addr_candidates)

    # Deduplicated candidate list (last scorer wins on id collision)
    all_candidates: List = list({
        c.id: c
        for c in quantity_candidates + price_candidates + order_candidates
            + date_candidates + email_candidates + ship_by_candidates
            + name_candidates + addr_candidates
    }.values())

    decision_rows: List[DecisionRow] = []

    if quantity_decision:
        decision_rows.append(quantity_decision)

    if price_decision:
        decision_rows.append(price_decision)

    if order_decision:
        decision_rows.append(order_decision)

    if date_decision:
        decision_rows.append(date_decision)

    if email_decision:
        decision_rows.append(email_decision)

    if ship_by_decision:
        decision_rows.append(ship_by_decision)

    if name_decision:
        decision_rows.append(name_decision)

    if addr_decision:
        decision_rows.append(addr_decision)

    # =========================
    # REPLAY (FINAL STEP)
    # =========================

    if ENABLE_REPLAY:
        for field, value in replay_data.items():
            if field == "quantity":
                continue
            # Skip replay for fields locked by a user-assigned span — injection
            # already placed the authoritative candidate; replay would only
            # corrupt it with value-only text search.
            if assignment_locked.get(field):
                continue

            existing = next((d for d in decision_rows if d.field == field), None)

            threshold = OVERRIDE_THRESHOLDS.get(field, 0.8)

            # Locate value in clean_text — must be exactly one match to be safe
            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
            if len(positions) != 1:
                continue  # not found or ambiguous — cannot guarantee clean_text[start:end] == value

            idx = positions[0]
            replay_start = idx
            replay_end = idx + len(value)

            if existing:
                if existing.value == value:
                    continue

                if existing.confidence < threshold:
                    existing.value = value
                    existing.start = replay_start
                    existing.end = replay_end
                    existing.confidence = 1.0
                    existing.decision_source = "replay_override"
                    existing.provenance = {
                        "signals": [f"replay_override(threshold={threshold})"],
                        "snippet": "overridden by replay",
                    }
            else:
                decision_rows.append(DecisionRow(
                    field=field,
                    value=value,
                    decision="suggested",
                    decision_source="replay",
                    candidate_id="",
                    start=replay_start,
                    end=replay_end,
                    confidence=1.0,
                    provenance={
                        "signals": ["replay"],
                        "snippet": "replayed from template",
                    },
                ))

    # =========================
    # CONFIDENCE PROMOTION
    # =========================
    # Only runs during genuine import/parse flows (update_confidence=True).
    # save_assignment and save_rejection flows set update_confidence=False so
    # that user interactions never touch the streak counters.
    #
    # After CONFIDENCE_PROMOTION_THRESHOLD (4) consecutive identical parses the
    # decision is promoted to 'assigned' for THIS parse only — nothing is
    # written to the hard learning store.

    # Build a rich signature map keyed by candidate_id for use in the
    # confidence block. template_id + field + signature is the streak key.
    _sig_map: Dict[str, str] = {
        c.id: build_extraction_signature(c, segment_map)
        for c in all_candidates
    }

    print(
        f"[CONF_DEBUG] confidence block — update_confidence={update_confidence}"
        f" {len(decision_rows)} decision_rows",
        file=sys.stderr, flush=True,
    )

    if not update_confidence:
        # Interaction-triggered reparse (save_assignment / save_rejection).
        # Do NOT increment any streak counters.
        # DO re-apply promotions that were already earned so that accepting
        # or rejecting one field never downgrades other confidence-promoted fields.
        _already_promoted = get_currently_promoted_fields(
            template_family_id,
            source_scopes={"quantity": learning_source},
        )
        print(
            f"[CONF_DEBUG] read-only promotion check — already_promoted={sorted(_already_promoted)}",
            file=sys.stderr, flush=True,
        )
        for _row in decision_rows:
            if _row.decision != "suggested":
                continue
            if _row.field in _already_promoted:
                _row.decision = "assigned"
                _row.decision_source = "confidence_promotion"
                print(
                    f"[CONF_DEBUG] re-applied promotion field={_row.field!r} (streak already met)",
                    file=sys.stderr, flush=True,
                )
    else:
        for _row in decision_rows:
            if _row.decision != "suggested":
                continue

            if _row.field == "quantity":
                # Quantity uses the richer context-anchored signature.
                # If the signature is too generic (returns None), skip confidence
                # tracking entirely for this parse — no streak increment, no promotion.
                _qty_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _qty_cand is None:
                    continue
                _sig = build_quantity_signature(_qty_cand, segment_map, clean_text)
                if _sig is None:
                    print(
                        f"[CONF_DEBUG] quantity sig too generic — skipping streak for value={_row.value!r}",
                        file=sys.stderr, flush=True,
                    )
                    continue
            else:
                # All other fields use the standard 3-part signature.
                # Falls back to decision_source for replay-generated rows.
                _sig = _sig_map.get(_row.candidate_id) or _row.decision_source or "unknown"

            _streak, _promoted = update_streak(
                template_family_id,
                _row.field,
                _sig,
                _row.value,
                source=learning_source if _row.field == "quantity" else "",
            )

            if _promoted:
                _row.decision = "assigned"
                _row.decision_source = "confidence_promotion"

    meta: Dict[str, Any] = {}
    lines = clean_text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.lower() not in _MESSAGE_LABELS:
            continue

        message_lines = []
        for next_line in lines[i + 1:]:
            next_stripped = next_line.strip()
            if not next_stripped:
                if message_lines:
                    break
                continue
            message_lines.append(next_stripped)

        if message_lines:
            meta["gift_message"] = " ".join(message_lines)
            break

    lower_text = clean_text.lower()
    normalized_text = re.sub(r"\s+", " ", lower_text).strip()
    has_message_content = bool(meta.get("gift_message"))
    flags = {
        "is_gift": (
            any(word in normalized_text for word in _GIFT_STRONG_WORDS)
            or (
                any(word in normalized_text for word in _GIFT_MEDIUM_WORDS)
                and has_message_content
            )
        ),
        "has_personalization": any(word in lower_text for word in _PERSONALIZATION_WORDS),
    }

    # =========================
    # FINAL CONTRACT VALIDATION (Category 6)
    # =========================
    # Drop any DecisionRow where start/end are set but clean_text[start:end] != value.
    # Rows with start=None or end=None (out-of-space) are allowed through.
    validated_decisions: List[DecisionRow] = []
    for row in decision_rows:
        if row.start is None or row.end is None:
            validated_decisions.append(row)
        elif clean_text[row.start:row.end] == row.value:
            validated_decisions.append(row)

    return {
        "subject": ingested.get("subject", ""),
        "clean_text": clean_text,
        "segments": segments,
        "segment_map": segment_map,
        "candidates": all_candidates,
        "decisions": validated_decisions,
        "flags": flags,
        "meta": meta,
        "template_id": template_id,
        "template_family_id": template_family_id,
        "learning_source": learning_source,
    }
