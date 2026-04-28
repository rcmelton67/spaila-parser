from typing import List, Dict, Any, Optional as _Opt
import hashlib
import json
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
from .learning.store import load_assignments, load_records, load_shipping_address_line_type_assignments
from .learning.confidence_store import update_streak, get_currently_promoted_fields

ENABLE_REPLAY = True
_GIFT_FLAG_WORDS = (
    "marked as gift",
    "this order is a gift",
    "gift details",
    "gift order",
)
_GIFT_MESSAGE_WORDS = ("gift message",)
_GIFT_WRAP_WORDS = ("gift wrap", "gift wrapped", "gift wrapping")

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


def _line_spans(text: str) -> List[Dict[str, Any]]:
    spans: List[Dict[str, Any]] = []
    cursor = 0
    for raw_line in text.splitlines(keepends=True):
        line_text = raw_line.rstrip("\r\n")
        spans.append({
            "text": line_text,
            "stripped": line_text.strip(),
            "start": cursor,
            "end": cursor + len(line_text),
        })
        cursor += len(raw_line)
    if not spans and text:
        spans.append({
            "text": text,
            "stripped": text.strip(),
            "start": 0,
            "end": len(text),
        })
    return spans


def _merge_attention_ranges(ranges: List[Dict[str, int]]) -> List[Dict[str, int]]:
    valid = sorted(
        [r for r in ranges if isinstance(r.get("start"), int) and isinstance(r.get("end"), int) and r["end"] > r["start"]],
        key=lambda item: (item["start"], item["end"]),
    )
    if not valid:
        return []
    merged = [dict(valid[0])]
    for current in valid[1:]:
        last = merged[-1]
        if current["start"] <= last["end"]:
            last["end"] = max(last["end"], current["end"])
            continue
        merged.append(dict(current))
    return merged


def _collect_gift_attention_ranges(clean_text: str) -> Dict[str, Any]:
    line_spans = _line_spans(clean_text)
    attention_ranges: List[Dict[str, int]] = []
    gift_message_detected = False

    for i, line in enumerate(line_spans):
        lowered = line["stripped"].lower()
        if not lowered:
            continue

        if any(word in lowered for word in _GIFT_MESSAGE_WORDS):
            gift_message_detected = True
            block_end = line["end"]
            saw_message_body = False
            for next_line in line_spans[i + 1:]:
                next_stripped = next_line["stripped"]
                if not next_stripped:
                    if saw_message_body:
                        break
                    continue
                saw_message_body = True
                block_end = next_line["end"]
            attention_ranges.append({
                "start": line["start"],
                "end": block_end,
            })

        if any(word in lowered for word in _GIFT_FLAG_WORDS + _GIFT_WRAP_WORDS):
            attention_ranges.append({
                "start": line["start"],
                "end": line["end"],
            })

    normalized_text = re.sub(r"\s+", " ", clean_text.lower()).strip()
    return {
        "gift": any(word in normalized_text for word in _GIFT_FLAG_WORDS),
        "gift_message": (
            gift_message_detected
            or any(word in normalized_text for word in _GIFT_MESSAGE_WORDS)
        ),
        "gift_wrap": any(word in normalized_text for word in _GIFT_WRAP_WORDS),
        "gift_attention_ranges": _merge_attention_ranges(attention_ranges),
    }

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

# Etsy sale-header quantity pattern.  Group 1 captures the item count.
# "Congratulations on your Etsy sale of N item(s)" is the ORDER-LEVEL source.
# Defined here (before _QUANTITY_BLOCK_SIGNALS) so the regex can be referenced
# as the first, highest-priority entry in the signal list.
_ETSY_SALE_HEADER_QTY_RE = re.compile(
    r"\b(?:sale of|you sold|congratulations[^.]*?sale)\s+(\d+)\s+items?\b",
    re.IGNORECASE,
)
# Alias for downstream code that checks without using the capture group.
_SALE_HEADER_RE = _ETSY_SALE_HEADER_QTY_RE

# Ordered list of (pattern, anchor_label).  First match in the ±50-char window
# wins.  Anchors are deliberately platform-specific so Etsy and Woo signatures
# never collide on the generic "number_regex|none|body" fallback.
_QUANTITY_BLOCK_SIGNALS: list = [
    # Etsy sale-header is the highest-priority, most specific anchor.
    # Always checked first so it can't be shadowed by generic order/purchase.
    (_ETSY_SALE_HEADER_QTY_RE, "sale_header"),
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


# ---------------------------------------------------------------------------
# Structural validity gate (Phase 2)
# Identifies candidates that must NOT earn confidence streaks, replay
# promotion, or auto-assignment regardless of their score.
# ---------------------------------------------------------------------------

_BAD_BUYER_NAME_VALUES: frozenset = frozenset({
    "purchase shipping label",
    "shipping label",
    "print shipping label",
    "buy shipping label",
})

# Fields whose "assigned" decisions (from structural anchor, not from
# confidence_promotion or learned replay) are also allowed to build confidence
# streaks.  This enables header/subject date fields to reach autopromotion.
_CONF_ALLOW_ASSIGNED_STREAK: frozenset = frozenset({"order_date", "ship_by"})

_ORDER_NUMBER_MIN_LEN = 3


def _is_structurally_valid(candidate, field: str) -> bool:
    """Return False for candidates that should never trigger streak promotion.

    Candidates that fail this gate may still WIN on score (they can be
    suggested), but they will NOT increment confidence streaks and will NOT
    be eligible for replay promotion or auto-assignment.
    """
    value = (getattr(candidate, "value", None) or "").strip()
    if not value:
        return False

    if field == "quantity":
        seg_text = getattr(candidate, "segment_text", "") or ""
        left = getattr(candidate, "left_context", "") or ""
        # Sale-header counts ARE the authoritative Etsy order-level quantity.
        # Explicitly allow them so they can earn confidence streaks.
        if _ETSY_SALE_HEADER_QTY_RE.search(seg_text) or re.search(
            r"\bsale of\b", left, re.IGNORECASE
        ):
            return True

    elif field == "order_number":
        if len(value) < _ORDER_NUMBER_MIN_LEN:
            return False
        if "." in value:
            return False

    elif field == "buyer_name":
        if " " not in value and "&" not in value:
            return False
        if len(value) < 4:
            return False
        if value.lower() in _BAD_BUYER_NAME_VALUES:
            return False

    return True


_ZIP_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")
_STATE_ZIP_RE = re.compile(r"\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b")
_STREET_LINE_RE = re.compile(
    r"^\d[\d\-]*\s+.+\b(?:"
    r"dr|drive|rd|road|st|street|ave|avenue|blvd|boulevard|"
    r"ln|lane|way|ct|court|cv|cove|"
    r"pl|place|ter|terrace|trl|trail|"
    r"pkwy|parkway|hwy|highway|fwy|freeway|"
    r"cir|circle|loop|sq|sqr|square|"
    r"pt|point|aly|alley|crk|creek|"
    r"grv|grove|hl|hill|vly|valley|"
    r"mnr|manor|mdws|meadows|rdg|ridge|"
    r"lndg|landing|run|walk|row|pass|"
    r"bnd|bend|xing|crossing|close|gate"
    r")\.?\b",
    re.IGNORECASE,
)
_COUNTRY_LINE_RE = re.compile(r"\b(?:united states|usa|canada|australia|united kingdom|uk)\b", re.IGNORECASE)
_COMPANY_LINE_RE = re.compile(r"\b(?:llc|inc|co\.?|company|corp|ltd|memorials|shop|store|studio)\b", re.IGNORECASE)


def _shipping_address_pattern_hints(value: str) -> Dict[str, bool]:
    lines = [line.strip() for line in (value or "").splitlines() if line.strip()]
    joined = "\n".join(lines)
    return {
        "contains_zip": bool(_ZIP_RE.search(joined)),
        "contains_state_zip": bool(_STATE_ZIP_RE.search(joined)),
        "contains_street_line": any(_STREET_LINE_RE.search(line) for line in lines),
        "contains_country": bool(lines and lines[-1].lower() in {"united states", "usa", "canada", "australia"}),
    }


def _normalize_line_match(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().casefold()


def classify_shipping_address_line(line: str, buyer_name: str = "") -> str:
    text = re.sub(r"\s+", " ", line or "").strip()
    lowered = text.casefold()
    buyer = _normalize_line_match(buyer_name)
    if buyer and lowered == buyer:
        line_type = "name"
    elif _COUNTRY_LINE_RE.search(text):
        line_type = "country"
    elif _STREET_LINE_RE.search(text):
        line_type = "street"
    elif "," in text and _STATE_ZIP_RE.search(text):
        line_type = "city_state_zip"
    elif _ZIP_RE.search(text):
        line_type = "city_state_zip"
    elif _COMPANY_LINE_RE.search(text):
        line_type = "company"
    else:
        line_type = "unknown"
    print(
        "[ADDRESS_LINE_CLASSIFICATION] "
        + json.dumps({"line": text, "type": line_type}, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return line_type


def split_shipping_address_candidate_lines(candidate, buyer_name: str = "") -> List[Dict[str, Any]]:
    lines: List[Dict[str, Any]] = []
    base_start = candidate.start if isinstance(getattr(candidate, "start", None), int) else None
    for span in _line_spans(candidate.value or ""):
        text = span["stripped"]
        if not text:
            continue
        start = base_start + span["start"] if base_start is not None else None
        end = base_start + span["end"] if base_start is not None else None
        lines.append({
            "text": text,
            "type": classify_shipping_address_line(text, buyer_name),
            "start": start,
            "end": end,
        })
    return lines


def build_shipping_address_line_learning(
    candidate,
    selected_start: int,
    selected_end: int,
    buyer_name: str = "",
) -> Dict[str, Any]:
    lines = split_shipping_address_candidate_lines(candidate, buyer_name)
    selected_types: List[str] = []
    excluded_types: List[str] = []
    for line in lines:
        line_start = line.get("start")
        line_end = line.get("end")
        overlaps_selection = (
            isinstance(line_start, int)
            and isinstance(line_end, int)
            and line_start < selected_end
            and selected_start < line_end
        )
        target = selected_types if overlaps_selection else excluded_types
        line_type = line["type"]
        if line_type not in target:
            target.append(line_type)
    return {
        "learned_line_types": selected_types,
        "excluded_line_types": [line_type for line_type in excluded_types if line_type not in selected_types],
        "line_count_pattern": len(lines),
    }


def _shipping_address_relative_position(candidate, segments: List[Any]) -> Dict[str, Any]:
    total = max(len(segments), 1)
    index = next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)
    if index is None:
        return {}

    previous_label = ""
    for prev in reversed(segments[:index]):
        lowered = prev.text.lower()
        if any(label in lowered for label in ("shipping address", "billing address", "ship to", "deliver to", "recipient")):
            previous_label = re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")
            break

    return {
        "segment_index": index,
        "segment_ratio": round(index / total, 4),
        "previous_label": previous_label,
    }


def build_shipping_address_signature(candidate, segment_map: Dict) -> str:
    """Build a structure-only signature for shipping-address learning.

    The signature deliberately excludes the address text so one corrected
    address block can teach the parser where future address blocks live.
    """
    return build_extraction_signature(candidate, segment_map)


_PRICE_LABEL_PATTERNS: tuple = (
    ("order_total", re.compile(r"\border\s+total\b|\bgrand\s+total\b|\breceipt\s+total\b|\bpayment\s+total\b", re.IGNORECASE)),
    ("sales_tax", re.compile(r"\bsales\s+tax\b|\btax\b", re.IGNORECASE)),
    ("shipping", re.compile(r"\bshipping\b|\bpostage\b|\bdelivery\b", re.IGNORECASE)),
    ("discount", re.compile(r"\bdiscount\b|\bcoupon\b|\bpromo\b", re.IGNORECASE)),
    ("subtotal", re.compile(r"\bsubtotal\b", re.IGNORECASE)),
    ("item_total", re.compile(r"\bitem\s+total\b|\bline\s+total\b", re.IGNORECASE)),
    ("item_price", re.compile(r"\bitem\s+price\b|\bunit\s+price\b|\bprice\b|\beach\b|\bper\s+unit\b", re.IGNORECASE)),
    ("product", re.compile(r"\bproduct\b|\bitem\b|\blisting\b|\bsku\b|\bvariation\b|\bquantity\b|\bqty\b", re.IGNORECASE)),
)
_PRICE_AGGREGATE_LABELS = {"order_total", "sales_tax", "shipping", "discount", "subtotal"}
_PRICE_ITEM_LABELS = {"item_total", "item_price", "product"}


def _price_candidate_index(candidate, segments: List[Any]) -> _Opt[int]:
    return next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)


def _normalize_label_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")


def _price_nearby_label(candidate, segments: List[Any]) -> str:
    idx = _price_candidate_index(candidate, segments)
    if idx is None:
        search_text = " ".join([candidate.segment_text or "", candidate.left_context or "", candidate.right_context or ""])
        for label, pattern in _PRICE_LABEL_PATTERNS:
            if pattern.search(search_text):
                return label
        return "none"

    direct_text = " ".join([segments[idx].text, candidate.left_context or "", candidate.right_context or ""])
    for label, pattern in _PRICE_LABEL_PATTERNS:
        if pattern.search(direct_text):
            return label

    offsets = [1, -1, 2, -2, 3, -3]
    for offset in offsets:
        nearby_idx = idx + offset
        if nearby_idx < 0 or nearby_idx >= len(segments):
            continue
        search_text = segments[nearby_idx].text
        for label, pattern in _PRICE_LABEL_PATTERNS:
            if pattern.search(search_text):
                return label
    return "none"


def _price_context_class(candidate, segments: List[Any]) -> str:
    label = _price_nearby_label(candidate, segments)
    if label in {"order_total"}:
        return "aggregate_total"
    if label in {"sales_tax"}:
        return "tax"
    if label in {"shipping"}:
        return "shipping"
    if label in {"discount"}:
        return "discount"
    if label in {"subtotal"}:
        return "subtotal"
    if label in _PRICE_ITEM_LABELS:
        return "item_price"
    return "price_unknown"


def classify_price_type(candidate, segments: List[Any]) -> str:
    label = _price_nearby_label(candidate, segments)
    context_text = " ".join([
        candidate.segment_text or "",
        candidate.left_context or "",
        candidate.right_context or "",
    ]).lower()
    if label == "item_total" or "item total" in context_text:
        return "item_total"
    if label == "order_total" or "order total" in context_text or "grand total" in context_text:
        return "order_total"
    if label == "shipping" or "shipping" in context_text or "postage" in context_text:
        return "shipping"
    if label == "sales_tax" or "sales tax" in context_text or re.search(r"\btax\b", context_text):
        return "tax"
    if label == "discount" or "discount" in context_text:
        return "discount"
    if label == "subtotal" or "subtotal" in context_text:
        return "subtotal"
    if label == "item_price" or label == "product" or re.search(r"\b(price|item|product|variation|listing|each|unit)\b", context_text):
        return "item_price"
    if "total" in context_text:
        return "order_total"
    return "unknown_price"


def _price_section_type(candidate, segments: List[Any]) -> str:
    label = _price_nearby_label(candidate, segments)
    if label in _PRICE_AGGREGATE_LABELS:
        return "summary"
    if label in _PRICE_ITEM_LABELS:
        return "item"
    return _candidate_segment_role(candidate, {seg.id: seg for seg in segments}) if segments else "unknown"


def _price_relative_position(candidate, segments: List[Any]) -> Dict[str, Any]:
    total = max(len(segments), 1)
    idx = _price_candidate_index(candidate, segments)
    if idx is None:
        return {}

    previous_label = ""
    for prev in reversed(segments[:idx]):
        for label, pattern in _PRICE_LABEL_PATTERNS:
            if pattern.search(prev.text):
                previous_label = label
                break
        if previous_label:
            break

    return {
        "segment_index": idx,
        "segment_ratio": round(idx / total, 4),
        "previous_label": previous_label,
    }


def build_price_signature(candidate, segment_map: Dict, segments: List[Any] | None = None) -> str:
    """Build a structure-only signature for price learning."""
    extractor = candidate.extractor or "unknown"
    label = _price_nearby_label(candidate, segments or [])
    section = _price_section_type(candidate, segments or []) if segments else _infer_segment_role(candidate.segment_text or "")
    context_class = _price_context_class(candidate, segments or []) if segments else label
    return f"{extractor}|{label}|{section}|{context_class}"


def _selected_body_part(ingested: Dict[str, Any]) -> str:
    if ingested.get("html"):
        return "text/html"
    if ingested.get("plain"):
        return "text/plain"
    return "none"


def _log_canon_compare(path: str, ingested: Dict[str, Any], clean_text: str, segments: List[Any]) -> None:
    canonical_hash = hashlib.sha256(clean_text.encode("utf-8", errors="ignore")).hexdigest()
    payload = {
        "source_file": path,
        "raw_size": ingested.get("_raw_size", 0),
        "parsed_text_length": len(clean_text),
        "html_text_length": len(ingested.get("html") or ""),
        "plain_text_length": len(ingested.get("plain") or ""),
        "selected_body_part": _selected_body_part(ingested),
        "canonical_text_hash": canonical_hash,
        "segment_count": len(segments),
        "first_1000_chars_of_parser_text": clean_text[:1000],
    }
    print(f"[CANON_COMPARE_INPUT] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)

    normalized_path = path.replace("/", "\\").lower()
    normalized_payload = {
        "source_file": path,
        "canonical_text_hash": canonical_hash,
        "segment_count": len(segments),
        "first_500_chars": clean_text[:500],
    }
    if "orders\\" in normalized_path:
        print(f"[BASELINE_NORMALIZED] {json.dumps(normalized_payload, ensure_ascii=False)}", file=sys.stderr, flush=True)
    elif "inbox\\" in normalized_path:
        print(f"[IMAP_NORMALIZED] {json.dumps(normalized_payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def _log_decision_rows_diff(path: str, decision_rows: List[DecisionRow]) -> None:
    interesting_fields = {
        "order_number",
        "buyer_name",
        "buyer_email",
        "shipping_address",
        "quantity",
        "price",
        "ship_by",
        "order_date",
    }
    payload = {
        "source_file": path,
        "rows": [
            {
                "field": row.field,
                "value": row.value,
                "decision": row.decision,
                "confidence": row.confidence,
                "start": row.start,
                "end": row.end,
                "source": row.decision_source,
                "snippet": row.provenance.get("snippet", ""),
            }
            for row in decision_rows
            if row.field in interesting_fields
        ],
    }
    print(f"[DECISION_ROWS_DIFF] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def _log_field_decision_proof(
    path: str,
    field: str,
    candidates: List[Candidate],
    decision: _Opt[DecisionRow],
    scale: float,
) -> None:
    ranked = sorted(
        candidates,
        key=lambda c: (-getattr(c, "score", 0.0), c.start if c.start is not None else 0),
    )
    payload = {
        "source_file": path,
        "field": field,
        "selected_value": decision.value if decision else None,
        "selected_candidate_id": decision.candidate_id if decision else None,
        "selected_confidence": decision.confidence if decision else 0.0,
        "why_winner_won": decision.provenance.get("signals", []) if decision else [],
        "candidates": [
            {
                "candidate_id": cand.id,
                "value": cand.value,
                "extractor": cand.extractor,
                "source": getattr(cand, "source", ""),
                "snippet": (cand.segment_text or cand.raw_text or "")[:240],
                "score": round(getattr(cand, "score", 0.0), 4),
                "confidence": min(1.0, max(0.0, getattr(cand, "score", 0.0)) / scale),
                "signals": getattr(cand, "signals", []),
                "penalties": getattr(cand, "penalties", []),
                "winner": bool(decision and cand.id == decision.candidate_id),
            }
            for cand in ranked
        ],
    }
    print(f"[FIELD_DECISION_PROOF] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


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

    Special case: if the candidate sits inside an Etsy sale-header context
    ("Congratulations on your Etsy sale of N items."), the signature is
    always the platform-specific sentinel "etsy_sale_header_count" regardless
    of the extractor or label — this ensures correct replay and confidence
    tracking across emails with different item counts.
    """
    extractor = candidate.extractor or "unknown"
    label_key = _infer_label_key(candidate)
    context_anchor = _derive_quantity_context_anchor(candidate, clean_text)

    # Sale-header context → dedicated, non-generic Etsy signature.
    if context_anchor == "sale_header":
        return "etsy_sale_header_count"

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
    # Only active records contribute to signature scoring — inactive/deactivated
    # records must not boost candidates using stale learned signatures.
    active_records = [r for r in records if r.get("active", True)]
    if not active_records:
        return candidates

    learned_sigs = {r["learned_signature"] for r in active_records if r.get("learned_signature")}
    if not learned_sigs:
        return candidates

    # Pre-compute extractor+role/anchor pairs for partial matching (parts 0 and 2).
    # Still derived from learned_sigs which is already active-filtered.
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
        elif field == "price":
            sig = build_price_signature(candidate, segment_map)
        elif field == "shipping_address":
            sig = build_shipping_address_signature(candidate, segment_map)
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


def _learned_replay_candidate(
    field: str,
    index: int,
    value: str,
    raw_text: str,
    start: int,
    end: int,
    segment_id: str,
    segment_text: str,
    record: Dict,
    signals: List[str] | None = None,
) -> Candidate:
    return Candidate(
        id=f"learned_{field}_{index + 1:04d}",
        field_type=field,
        value=value,
        raw_text=raw_text,
        start=start,
        end=end,
        segment_id=segment_id,
        extractor="learning",
        signals=signals or ["assigned_span(authoritative)"],
        penalties=[],
        score=999,
        segment_text=segment_text,
        left_context=record.get("left_context", ""),
        right_context=record.get("right_context", ""),
        source="learned",
    )


def _candidate_segment_role(candidate, segment_map: Dict) -> str:
    seg = segment_map.get(candidate.segment_id) if candidate.segment_id else None
    return _infer_segment_role(candidate.segment_text or (seg.text if seg else ""))


def _price_metadata(candidate, segments: List[Any], segment_map: Dict) -> Dict[str, Any]:
    signature = build_price_signature(candidate, segment_map, segments)
    return {
        "learned_signature": signature,
        "price_type": classify_price_type(candidate, segments),
        "nearby_label": _price_nearby_label(candidate, segments),
        "section_type": _price_section_type(candidate, segments),
        "context_class": _price_context_class(candidate, segments),
        "relative_position": _price_relative_position(candidate, segments),
    }


def _price_trace_candidates(candidates: List, segments: List[Any], segment_map: Dict) -> None:
    for candidate in candidates:
        meta = _price_metadata(candidate, segments, segment_map)
        payload = {
            "candidate_id": candidate.id,
            "value": candidate.value,
            "start": candidate.start,
            "end": candidate.end,
            "extractor": candidate.extractor,
            "learned_signature": meta["learned_signature"],
            "segment_id": candidate.segment_id,
            "price_type": meta["price_type"],
            "nearby_label": meta["nearby_label"],
            "section_type": meta["section_type"],
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "signals": candidate.signals,
            "score": round(candidate.score, 4),
        }
        print(f"[PRICE_CANDIDATE_CLASSIFICATION] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def _price_record_score(record: Dict, candidate, segments: List[Any], segment_map: Dict) -> tuple[float, List[str]]:
    meta = _price_metadata(candidate, segments, segment_map)
    score = 0.0
    signals: List[str] = []

    learned_price_type = record.get("price_type") or record.get("context_class") or ""
    if learned_price_type:
        current_price_type = meta["price_type"]
        if current_price_type != learned_price_type:
            return -999.0, [f"price_type_mismatch({current_price_type}!={learned_price_type})"]
        score += 40.0
        signals.append(f"price_type_match(+40:{current_price_type})")

    stored_sig = record.get("learned_signature") or ""
    if stored_sig and meta["learned_signature"] == stored_sig:
        score += 12.0
        signals.append("price_sig_exact(+12)")
    elif stored_sig:
        stored_parts = stored_sig.split("|")
        current_parts = meta["learned_signature"].split("|")
        if len(stored_parts) >= 4 and len(current_parts) >= 4 and stored_parts[0] == current_parts[0] and stored_parts[2] == current_parts[2]:
            score += 6.0
            signals.append("price_sig_section_partial(+6)")

    if record.get("extractor") and candidate.extractor == record.get("extractor"):
        score += 3.0
        signals.append("price_extractor_match(+3)")
    if record.get("section_type") and meta["section_type"] == record.get("section_type"):
        score += 4.0
        signals.append("price_section_match(+4)")
    if record.get("nearby_label") and meta["nearby_label"] == record.get("nearby_label"):
        score += 4.0
        signals.append("price_label_match(+4)")
    if record.get("context_class") and meta["context_class"] == record.get("context_class"):
        score += 4.0
        signals.append("price_context_match(+4)")

    if meta["price_type"] == "item_price":
        score += 6.0
        signals.append("item_price_type(+6)")
    elif meta["price_type"] in {"order_total", "tax", "shipping", "discount", "subtotal"}:
        score -= 14.0
        signals.append(f"summary_price_type(-14:{meta['price_type']})")

    if "summary_section(−6.0)" in candidate.penalties or "near_order_total(−5.0)" in candidate.penalties or "segment_is_total(−5.0)" in candidate.penalties:
        score -= 6.0
        signals.append("existing_summary_penalty(-6)")

    return score, signals


def _price_record_matches_candidate(record: Dict, candidate, segments: List[Any], segment_map: Dict) -> bool:
    score, _signals = _price_record_score(record, candidate, segments, segment_map)
    return score >= 10.0


def _price_rejection_matches_candidate(record: Dict, candidate, segments: List[Any], segment_map: Dict) -> bool:
    if record.get("price_type"):
        meta = _price_metadata(candidate, segments, segment_map)
        if meta["price_type"] != record.get("price_type"):
            return False
        if record.get("learned_signature") and meta["learned_signature"] == record.get("learned_signature"):
            return True
        if record.get("extractor") and candidate.extractor != record.get("extractor"):
            return False
        if record.get("section_type") and meta["section_type"] != record.get("section_type"):
            return False
        if record.get("nearby_label") and meta["nearby_label"] != record.get("nearby_label"):
            return False
        return True
    if record.get("candidate_id"):
        return candidate.id == record.get("candidate_id")
    if record.get("learned_signature") and build_price_signature(candidate, segment_map, segments) == record.get("learned_signature"):
        return True
    return _price_record_matches_candidate(record, candidate, segments, segment_map)


def _apply_price_rejections(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
) -> List:
    records = [
        record for record in load_records(template_id, field="price", record_type="reject")
        if record.get("active", True)
    ]
    if not records:
        return candidates

    for candidate in candidates:
        for record in records:
            if not _price_rejection_matches_candidate(record, candidate, segments, segment_map):
                continue
            candidate.score -= 60.0
            candidate.penalties.append("rejected_price_structure(-60)")
            break
    return candidates


# Price types that represent aggregate / summary totals rather than a line-item
# price.  A price assignment derived from one of these rows must NOT replay as
# the authoritative item price — doing so causes Woo subtotal contamination
# where the order subtotal (e.g. $59.99) gets locked in even when there are
# separate line-item prices on the same email.
_SUMMARY_PRICE_TYPES: frozenset = frozenset({
    "order_total", "item_total", "subtotal", "tax", "shipping", "discount",
})


def _select_price_structural_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[tuple[Any, float, List[str], Dict]]:
    assigned_records = load_assignments(template_id, "price")
    if not assigned_records:
        return None

    # Phase 4 — filter out records that were learned from a subtotal / total
    # context.  These should never be authoritative for the item price.
    item_records = [
        r for r in assigned_records
        if (r.get("price_type") or r.get("context_class", "")) not in _SUMMARY_PRICE_TYPES
    ]
    if not item_records:
        print(
            "[PRICE_STRUCTURAL_SKIP] all assigned price records are summary/total type"
            " — falling back to score-based selection",
            file=sys.stderr,
            flush=True,
        )
        return None
    assigned_records = item_records

    learned_price_type = assigned_records[0].get("price_type") or assigned_records[0].get("context_class", "")
    print(
        f"[PRICE_TYPE_REPLAY_ATTEMPT] {json.dumps({'learned_price_type': learned_price_type, 'candidate_count': len(candidates)}, ensure_ascii=False)}",
        file=sys.stderr,
        flush=True,
    )

    rejected_records = [
        record for record in load_records(template_id, field="price", record_type="reject")
        if record.get("active", True)
    ]
    best: _Opt[tuple[Any, float, List[str], Dict]] = None
    for record in assigned_records:
        for candidate in candidates:
            score, signals = _price_record_score(record, candidate, segments, segment_map)
            if any(_price_rejection_matches_candidate(rejection, candidate, segments, segment_map) for rejection in rejected_records):
                score -= 60.0
                signals.append("rejected_price_structure(-60)")
            if best is None or score > best[1]:
                best = (candidate, score, signals, record)

    if best is None or best[1] < 10.0:
        print(
            f"[PRICE_TYPE_REPLAY_FAILED] {json.dumps({'reason': 'no_matching_price_type'}, ensure_ascii=False)}",
            file=sys.stderr,
            flush=True,
        )
        return None

    candidate, score, signals, _record = best
    meta = _price_metadata(candidate, segments, segment_map)
    payload = {
        "candidate_id": candidate.id,
        "value": candidate.value,
        "price_type": meta["price_type"],
        "score": round(score, 4),
        "signals": signals,
    }
    print(f"[PRICE_TYPE_REPLAY_SELECTED] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)
    return best


def _shipping_record_matches_candidate(record: Dict, candidate, segment_map: Dict) -> bool:
    learned_sig = record.get("learned_signature") or ""
    candidate_sig = build_shipping_address_signature(candidate, segment_map)
    if learned_sig and learned_sig != candidate_sig:
        return False
    if record.get("extractor") and candidate.extractor != record.get("extractor"):
        return False

    record_role = ""
    parts = learned_sig.split("|")
    if len(parts) >= 3:
        record_role = parts[2]
    if record_role and _candidate_segment_role(candidate, segment_map) != record_role:
        return False
    return True


def _shipping_rejection_matches_candidate(record: Dict, candidate, segment_map: Dict) -> bool:
    if record.get("candidate_id") and candidate.id != record.get("candidate_id"):
        return False
    return _shipping_record_matches_candidate(record, candidate, segment_map)


def _boost_shipping_address_assignments(
    template_id: str,
    candidates: List,
    segments: List,
    segment_map: Dict,
) -> List:
    records = load_assignments(template_id, "shipping_address")
    if not records:
        return candidates

    for candidate in candidates:
        for record in records:
            if not _shipping_record_matches_candidate(record, candidate, segment_map):
                continue
            candidate.score += 25.0
            candidate.signals.append("assigned_structure(+25)")
            candidate.source = "learned"
            break
    return candidates


def _apply_shipping_address_rejections(
    template_id: str,
    candidates: List,
    segment_map: Dict,
) -> List:
    records = [
        record for record in load_records(template_id, field="shipping_address", record_type="reject")
        if record.get("active", True)
    ]
    if not records:
        return candidates

    for candidate in candidates:
        for record in records:
            if not _shipping_rejection_matches_candidate(record, candidate, segment_map):
                continue
            candidate.score -= 50.0
            candidate.penalties.append("rejected_structure(-50)")
            break
    return candidates


def _select_shipping_address_line_type_candidate(
    template_id: str,
    candidates: List,
    buyer_name: str = "",
    source: str = "",
) -> _Opt[Any]:
    records = load_shipping_address_line_type_assignments(template_id, source=source)
    if not records:
        return None

    best = None
    for record in records:
        learned_types = [line_type for line_type in record.get("learned_line_types", []) if line_type]
        if not learned_types:
            continue
        learned_set = set(learned_types)
        for candidate in candidates:
            lines = split_shipping_address_candidate_lines(candidate, buyer_name)
            # Primary selection: lines whose type is explicitly learned.
            primary_indices = [i for i, line in enumerate(lines) if line["type"] in learned_set]
            selected_lines = [lines[i] for i in primary_indices]
            present_types = {line["type"] for line in selected_lines}
            if not selected_lines or not learned_set.issubset(present_types):
                continue
            # Include "unknown"-typed lines that fall BETWEEN the first and last
            # explicitly recognized line (e.g. apartment/unit/suite numbers).
            # These are structural continuation lines, not buyer-name or country.
            if primary_indices:
                first_idx, last_idx = primary_indices[0], primary_indices[-1]
                if last_idx > first_idx:
                    selected_lines = [
                        line for i, line in enumerate(lines)
                        if line["type"] in learned_set
                        or (first_idx < i < last_idx and line["type"] == "unknown")
                    ]
            score = len(selected_lines) * 10.0 + len(present_types) + (candidate.score or 0.0) / 100.0
            if best is None or score > best["score"]:
                best = {
                    "candidate": candidate,
                    "record": record,
                    "lines": selected_lines,
                    "score": score,
                    "learned_line_types": learned_types,
                }

    if best is None:
        return None

    final_output = "\n".join(line["text"] for line in best["lines"]).strip()
    print(
        "[ADDRESS_LEARNING_APPLIED] "
        + json.dumps({
            "learned_line_types": best["learned_line_types"],
            "selected_lines": [line["text"] for line in best["lines"]],
            "final_output": final_output,
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    candidate = best["candidate"]
    first_line = best["lines"][0]
    last_line = best["lines"][-1]
    return Candidate(
        id="learned_shipping_address_0001",
        field_type="shipping_address",
        value=final_output,
        raw_text=final_output,
        start=first_line.get("start"),
        end=last_line.get("end"),
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=["assigned_line_types(authoritative)"],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="learned",
    )


def _trim_address_duplicate_buyer_name(address_decision: _Opt[DecisionRow], buyer_decision: _Opt[DecisionRow]) -> _Opt[DecisionRow]:
    if address_decision is None or buyer_decision is None:
        return address_decision
    if any(signal.startswith("assigned_line_types(") for signal in address_decision.provenance.get("signals", [])):
        return address_decision

    buyer_name = (buyer_decision.value or "").strip()
    lines = (address_decision.value or "").splitlines()
    if not buyer_name or not lines:
        return address_decision

    if lines[0].strip() != buyer_name:
        return address_decision

    trimmed_value = "\n".join(lines[1:]).strip()
    if not trimmed_value:
        return address_decision

    start = address_decision.start
    if isinstance(start, int):
        start += len(lines[0])
        original_value = address_decision.value or ""
        if original_value.startswith(lines[0] + "\r\n"):
            start += 2
        elif original_value.startswith(lines[0] + "\n"):
            start += 1

    address_decision.value = trimmed_value
    address_decision.start = start
    if isinstance(start, int):
        address_decision.end = start + len(trimmed_value)
    address_decision.provenance.setdefault("signals", []).append("buyer_name_trimmed_from_address")
    address_decision.provenance["snippet"] = trimmed_value
    return address_decision


# ── Phase 3: Canonical address formatting ─────────────────────────────────────
_CITY_STATE_ZIP_NORM_RE = re.compile(
    r"^([A-Za-z][A-Za-z\s\-\.]+?)\s*,\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$"
)


def _canonical_address_value(value: str) -> str:
    """Normalise each line of a shipping address for consistent DB storage.

    Applies:
    - Collapse internal runs of spaces to single space
    - Strip leading/trailing whitespace per line
    - Title-case the city component in "CITY , ST ZIP" lines
    - Normalise "CITY , ST" → "City, ST" (remove space before comma)
    - Remove standalone "United States" / "USA" country line (already excluded
      by line-type learning; belt-and-suspenders for un-learned addresses)
    """
    lines = value.splitlines()
    normalised = []
    for line in lines:
        line = re.sub(r"[ \t]+", " ", line).strip()
        if not line:
            continue
        # Remove standalone country line (belt-and-suspenders)
        if _COUNTRY_LINE_RE.search(line) and len(line.split()) <= 3:
            continue
        # Normalise "CITY , ST ZIP" or "CITY,ST ZIP" → "City, ST ZIP"
        m = _CITY_STATE_ZIP_NORM_RE.match(line)
        if m:
            city_raw, state, zipcode = m.group(1), m.group(2), m.group(3)
            city_title = city_raw.title()
            line = f"{city_title}, {state} {zipcode}"
        normalised.append(line)
    return "\n".join(normalised)


def _canonicalize_address_decision(
    address_decision: _Opt["DecisionRow"],
) -> _Opt["DecisionRow"]:
    """Apply canonical formatting to the address decision value in-place."""
    if address_decision is None:
        return None
    raw = address_decision.value or ""
    canonical = _canonical_address_value(raw)
    if canonical != raw:
        address_decision.value = canonical
        address_decision.provenance.setdefault("signals", []).append(
            "address_canonicalized"
        )
        address_decision.provenance["snippet"] = canonical
    return address_decision


def _inject_assigned_candidates(
    template_id: str,
    field: str,
    candidates: List,
    segments: List,
    clean_text: str,
    source: str | None = None,
    buyer_name: str = "",
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
        if field == "shipping_address":
            selected = _select_shipping_address_line_type_candidate(template_id, candidates, buyer_name, source=source or "")
            return [selected] if selected is not None else []
        return candidates

    # Etsy sale-header quantity — pattern-based injection.
    # Records with learned_signature "etsy_sale_header_count" use the sale-header
    # regex to extract the order-level count from the current email rather than
    # an exact position match (which would only work for a single email).
    if field == "quantity":
        for record in assigned_records:
            if record.get("learned_signature") == "etsy_sale_header_count":
                m = _ETSY_SALE_HEADER_QTY_RE.search(clean_text)
                if m:
                    qty_value = m.group(1)
                    # Locate where the number appears in the sale-header line.
                    match_start = m.start(1)
                    match_end = m.end(1)
                    seg_id = record.get("segment_id") or ""
                    print(
                        f"[SALE_HEADER_QTY_INJECT] value={qty_value!r}"
                        f" pos={match_start}:{match_end}",
                        file=sys.stderr,
                        flush=True,
                    )
                    return [Candidate(
                        id="learned_quantity_sale_header_0001",
                        field_type="quantity",
                        value=qty_value,
                        raw_text=qty_value,
                        start=match_start,
                        end=match_end,
                        segment_id=seg_id,
                        extractor="etsy_sale_header_count",
                        signals=["etsy_sale_header_injection(authoritative)"],
                        penalties=[],
                        score=999,
                        segment_text=m.group(0),
                        left_context=clean_text[max(0, match_start - 15): match_start],
                        right_context=clean_text[match_end: match_end + 15],
                        source="learned",
                    )]
                print(
                    "[SALE_HEADER_QTY_INJECT] sale-header not found in email"
                    " — falling back to score-based path",
                    file=sys.stderr,
                    flush=True,
                )
                return candidates  # fallback: no sale-header → score-based

    for i, record in enumerate(assigned_records):
        manual_candidate = _manual_record_exact_candidate(field, i, record, clean_text)
        if manual_candidate is not None:
            return [manual_candidate]

    if field == "shipping_address":
        selected = _select_shipping_address_line_type_candidate(template_id, candidates, buyer_name, source=source or "")
        return [selected] if selected is not None else []

    if field == "price":
        segment_map = {seg.id: seg for seg in segments}
        selected = _select_price_structural_candidate(template_id, candidates, segments, segment_map)
        if selected is None:
            return []

        best_candidate, _structural_score, structural_signals, _record = selected
        return [Candidate(
            id=f"learned_{field}_0001",
            field_type=field,
            value=best_candidate.value,
            raw_text=best_candidate.raw_text,
            start=best_candidate.start,
            end=best_candidate.end,
            segment_id=best_candidate.segment_id,
            extractor=best_candidate.extractor,
            signals=["assigned_price_type(authoritative)", *structural_signals],
            penalties=[],
            score=999,
            segment_text=best_candidate.segment_text,
            left_context=best_candidate.left_context,
            right_context=best_candidate.right_context,
            source="learned",
        )]

    if field == "quantity":
        best_candidate = None
        best_score = -1.0
        best_record = None
        trace_rows = []

        # assigned_records already filtered (sale-header gate above the manual
        # exact replay loop ensures no bypass path exists).

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
        preferred_text = record.get("selected_text") or value
        segment_id = record.get("segment_id", "")

        original_start = record.get("start")  # may be None for header/subject candidates
        original_end = record.get("end")

        print(
            f"[LEARNED_REPLAY_ATTEMPT] field={field!r} start={original_start!r} end={original_end!r} "
            f"has_selected_text={bool(record.get('selected_text'))!r} value={value!r} "
            f"selected_text_preview={preferred_text[:120]!r}",
            file=sys.stderr,
            flush=True,
        )

        if (
            isinstance(original_start, int)
            and isinstance(original_end, int)
            and 0 <= original_start <= original_end <= len(clean_text)
        ):
            if clean_text[original_start:original_end] == preferred_text:
                print(
                    f"[LEARNED_REPLAY_EXACT_SUCCESS] field={field!r} value={preferred_text!r} "
                    f"start={original_start} end={original_end}",
                    file=sys.stderr,
                    flush=True,
                )
                return [_learned_replay_candidate(
                    field,
                    i,
                    preferred_text,
                    preferred_text,
                    original_start,
                    original_end,
                    segment_id,
                    record.get("segment_text", "") or preferred_text,
                    record,
                )]
            print(
                f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='stored_range_mismatch'",
                file=sys.stderr,
                flush=True,
            )
        elif original_start is not None or original_end is not None:
            print(
                f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='invalid_stored_range'",
                file=sys.stderr,
                flush=True,
            )

        # Out-of-body candidates (header date, subject ship_by) may be stored with
        # start=None / end=None. They must still resolve against the current email
        # text before they can be injected; otherwise a stale literal value can leak
        # into unrelated parses.
        if original_start is None:
            val_len = len(value)
            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
            resolved = _resolve_positions(positions, val_len, clean_text, record)
            if resolved is None:
                continue
            start = resolved
            end = resolved + val_len
            raw_text = clean_text[start:end]
            line_start = clean_text.rfind("\n", 0, start) + 1
            line_end_raw = clean_text.find("\n", start)
            line_end = line_end_raw if line_end_raw != -1 else len(clean_text)
            segment_text = clean_text[line_start:line_end]
            return [_learned_replay_candidate(
                field,
                i,
                value,
                raw_text,
                start,
                end,
                segment_id,
                segment_text,
                record,
                signals=["assigned_span(authoritative)", "resolved_from_context"],
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
        elif "\n" in preferred_text:
            val_len = len(preferred_text)
            positions = [m.start() for m in re.finditer(re.escape(preferred_text), clean_text)]
            resolved = _resolve_positions(positions, val_len, clean_text, record)
            if resolved is None:
                print(
                    f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='selected_text_not_found'",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            start, end = resolved, resolved + val_len
            value = preferred_text

        # 3. Single-line selected text — try exact selected text before the
        # normalized fallback value.
        elif preferred_text != value:
            val_len = len(preferred_text)
            if segment_obj:
                seg_text = segment_obj.text
                first = seg_text.find(preferred_text)
                if first != -1 and seg_text.find(preferred_text, first + 1) == -1:
                    start = segment_obj.start + first
                    end = start + val_len
                    value = preferred_text
                else:
                    positions = [m.start() for m in re.finditer(re.escape(preferred_text), clean_text)]
                    resolved = _resolve_positions(positions, val_len, clean_text, record)
                    if resolved is None:
                        print(
                            f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='selected_text_not_found'",
                            file=sys.stderr,
                            flush=True,
                        )
                        val_len = len(value)
                        first = seg_text.find(value)
                        if first != -1 and seg_text.find(value, first + 1) == -1:
                            start = segment_obj.start + first
                            end = start + val_len
                        else:
                            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
                            resolved = _resolve_positions(positions, val_len, clean_text, record)
                            if resolved is None:
                                print(
                                    f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='normalized_value_not_found'",
                                    file=sys.stderr,
                                    flush=True,
                                )
                                continue
                            start, end = resolved, resolved + val_len
                    else:
                        start, end = resolved, resolved + val_len
                        value = preferred_text
            else:
                positions = [m.start() for m in re.finditer(re.escape(preferred_text), clean_text)]
                resolved = _resolve_positions(positions, val_len, clean_text, record)
                if resolved is None:
                    print(
                        f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='selected_text_not_found'",
                        file=sys.stderr,
                        flush=True,
                    )
                    val_len = len(value)
                    positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
                    resolved = _resolve_positions(positions, val_len, clean_text, record)
                    if resolved is None:
                        print(
                            f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='normalized_value_not_found'",
                            file=sys.stderr,
                            flush=True,
                        )
                        continue
                    start, end = resolved, resolved + val_len
                else:
                    start, end = resolved, resolved + val_len
                    value = preferred_text

        # 4. Single-line normalized fallback, original segment still exists —
        #    try segment-scoped search first to reduce false positives.
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

        # 5. No segment hint — search full clean_text with context scoring.
        else:
            positions = [m.start() for m in re.finditer(re.escape(value), clean_text)]
            resolved = _resolve_positions(positions, val_len, clean_text, record)
            if resolved is None:
                print(
                    f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='normalized_value_not_found'",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            start, end = resolved, resolved + val_len

        raw_text = preferred_text
        segment_text = record.get("segment_text", "") or raw_text

        # Span resolved — return it as the sole authoritative candidate.
        return [_learned_replay_candidate(
            field,
            i,
            value,
            raw_text,
            start,
            end,
            segment_id,
            segment_text,
            record,
        )]

    # Assignment exists but no position reached the confidence threshold.
    return []


def _field_is_rejected(template_id: str, field: str, source: str | None = None) -> bool:
    records = load_records(template_id, field=field, record_type="reject", source=source)
    return any(record.get("active", True) for record in records)


def _manual_record_exact_candidate(
    field: str,
    index: int,
    record: Dict,
    clean_text: str,
) -> Candidate | None:
    if record.get("assignment_source") != "manual":
        return None

    start = record.get("start")
    end = record.get("end")
    selected_text = record.get("selected_text") or record.get("value") or ""
    if (
        not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or end < start
        or end > len(clean_text)
        or clean_text[start:end] != selected_text
    ):
        return None

    print(
        f"[ASSIGNMENT_OVERRIDE_APPLIED] field={field!r} value={selected_text!r} start={start} end={end}",
        file=sys.stderr,
        flush=True,
    )
    return _learned_replay_candidate(
        field,
        index,
        selected_text,
        selected_text,
        start,
        end,
        record.get("segment_id", ""),
        record.get("segment_text", "") or selected_text,
        record,
        signals=["manual_assignment(authoritative)", "assigned_span(authoritative)"],
    )


def _manual_lock_decision(field: str, lock: Dict[str, Any], clean_text: str) -> DecisionRow:
    value = "" if lock.get("value") is None else str(lock.get("value"))
    start = lock.get("start")
    end = lock.get("end")
    print(
        f"[ASSIGNMENT_OVERRIDE_APPLIED] field={field!r} value={value!r} start={start!r} end={end!r}",
        file=sys.stderr,
        flush=True,
    )
    return DecisionRow(
        field=field,
        value=value,
        decision="assigned",
        decision_source="manual_override",
        candidate_id=f"manual_override_{field}",
        start=start if isinstance(start, int) else None,
        end=end if isinstance(end, int) else None,
        confidence=1.0,
        provenance={
            "segment_id": "manual",
            "snippet": value,
            "signals": ["manual_assignment_lock(authoritative)"],
        },
    )


def _apply_assignment_locks(
    decision_rows: List[DecisionRow],
    assignment_lock: Dict[str, Dict[str, Any]] | None,
    clean_text: str,
) -> List[DecisionRow]:
    if not assignment_lock:
        return decision_rows

    locked_rows = {
        field: _manual_lock_decision(field, lock, clean_text)
        for field, lock in assignment_lock.items()
    }
    next_rows = [row for row in decision_rows if row.field not in locked_rows]
    next_rows.extend(locked_rows.values())
    return next_rows


def _apply_assignment_policy(
    template_id: str,
    field: str,
    candidates: List,
    segments: List,
    clean_text: str,
    source: str | None = None,
    buyer_name: str = "",
) -> tuple[List, bool]:
    """Return candidates plus whether the field remains assignment-locked.

    Non-strict fields fall back to the normal scoring/replay path when an
    active assignment exists but its stored span no longer resolves.
    """
    if field == "shipping_address":
        if not load_assignments(template_id, field, source=source) and not load_shipping_address_line_type_assignments(template_id, source=source or ""):
            return candidates, False
    elif not load_assignments(template_id, field, source=source):
        return candidates, False

    assigned_candidates = _inject_assigned_candidates(
        template_id,
        field,
        candidates,
        segments,
        clean_text,
        source,
        buyer_name,
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


def parse_eml(
    path: str,
    update_confidence: bool = True,
    assignment_lock: Dict[str, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
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
    _log_canon_compare(path, ingested, clean_text, segments)

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
    quantity_decision = None if (
        not assignment_locked["quantity"] and _field_is_rejected(template_family_id, "quantity", source=learning_source)
    ) else decide_quantity(quantity_candidates)

    # --- PRICE ---
    price_candidates = score_price(candidates, segments, quantity_candidates)
    price_candidates = _apply_price_rejections(template_family_id, price_candidates, segments, segment_map)
    _price_trace_candidates(price_candidates, segments, segment_map)
    price_candidates, assignment_locked["price"] = _apply_assignment_policy(
        template_family_id, "price", price_candidates, segments, clean_text
    )
    if not assignment_locked["price"]:
        price_candidates = apply_anchor_scoring(template_family_id, "price", price_candidates)
        price_candidates = _apply_signature_scoring(price_candidates, template_family_id, "price", segment_map)
    price_decision = decide_price(price_candidates)

    # --- PRICE SELECTION TRACE ---
    _price_trace = sorted(
        [
            {
                "value": c.value,
                "score": round(c.score, 2),
                "signals": getattr(c, "signals", []),
                "penalties": getattr(c, "penalties", []),
            }
            for c in price_candidates
        ],
        key=lambda x: x["score"],
        reverse=True,
    )[:6]
    # order_number may not be decided yet; use a placeholder resolved below.
    _price_order_ref = getattr(price_decision, "value", None)

    # --- ORDER NUMBER ---
    order_candidates = score_order_number(candidates, segments)
    order_candidates, assignment_locked["order_number"] = _apply_assignment_policy(
        template_family_id, "order_number", order_candidates, segments, clean_text
    )
    if not assignment_locked["order_number"]:
        order_candidates = apply_anchor_scoring(template_family_id, "order_number", order_candidates)
        order_candidates = _apply_signature_scoring(order_candidates, template_family_id, "order_number", segment_map)
    order_decision = None if (
        not assignment_locked["order_number"] and _field_is_rejected(template_family_id, "order_number")
    ) else decide_order_number(order_candidates)

    # Emit price selection trace now that order_number is known.
    _order_num_for_log = order_decision.value if order_decision else "unknown"
    print(
        f"PRICE_SELECTION_TRACE {{"
        f" order_number: {_order_num_for_log!r},"
        f" selected_value: {getattr(price_decision, 'value', None)!r},"
        f" candidate_scores: {_price_trace} }}",
        file=sys.stderr, flush=True,
    )

    # Log template family mapping for debugging cross-email learning.
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
    date_decision = None if (
        not assignment_locked["order_date"] and _field_is_rejected(template_family_id, "order_date")
    ) else decide_order_date(date_candidates)

    # --- BUYER EMAIL ---
    email_candidates = validate_candidates(extract_emails(segments), clean_text)
    email_candidates = score_buyer_email(email_candidates, segments)
    email_candidates, assignment_locked["buyer_email"] = _apply_assignment_policy(
        template_family_id, "buyer_email", email_candidates, segments, clean_text
    )
    if not assignment_locked["buyer_email"]:
        email_candidates = apply_anchor_scoring(template_family_id, "buyer_email", email_candidates)
        email_candidates = _apply_signature_scoring(email_candidates, template_family_id, "buyer_email", segment_map)
    email_decision = None if (
        not assignment_locked["buyer_email"] and _field_is_rejected(template_family_id, "buyer_email")
    ) else decide_buyer_email(email_candidates)

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
    ship_by_decision = None if (
        not assignment_locked["ship_by"] and _field_is_rejected(template_family_id, "ship_by")
    ) else decide_ship_by(ship_by_candidates)

    # --- BUYER NAME ---
    name_candidates = validate_candidates(extract_buyer_name(segments), clean_text)
    name_candidates = score_buyer_name(name_candidates, segments)
    name_candidates, assignment_locked["buyer_name"] = _apply_assignment_policy(
        template_family_id, "buyer_name", name_candidates, segments, clean_text
    )
    if not assignment_locked["buyer_name"]:
        name_candidates = apply_anchor_scoring(template_family_id, "buyer_name", name_candidates)
        name_candidates = _apply_signature_scoring(name_candidates, template_family_id, "buyer_name", segment_map)
    name_decision = None if (
        not assignment_locked["buyer_name"] and _field_is_rejected(template_family_id, "buyer_name")
    ) else decide_buyer_name(name_candidates)

    # --- SHIPPING ADDRESS ---
    addr_candidates = validate_candidates(extract_shipping_address(segments), clean_text)
    addr_candidates = score_shipping_address(addr_candidates, segments)
    addr_candidates, assignment_locked["shipping_address"] = _apply_assignment_policy(
        template_family_id,
        "shipping_address",
        addr_candidates,
        segments,
        clean_text,
        buyer_name=name_decision.value if name_decision else "",
    )
    if not assignment_locked["shipping_address"]:
        addr_candidates = apply_anchor_scoring(template_family_id, "shipping_address", addr_candidates)
        addr_candidates = _apply_signature_scoring(addr_candidates, template_family_id, "shipping_address", segment_map)
    addr_decision = decide_shipping_address(addr_candidates)
    addr_decision = _trim_address_duplicate_buyer_name(addr_decision, name_decision)

    # Phase 1 — Conflict diagnostics: compare sale-header count with summed
    # item-line quantities.  A mismatch usually indicates a multi-item order
    # where the sale-header says "2 items" but two separate item rows each
    # show "Quantity: 1".  Log a warning for transparency; the sale-header
    # value remains authoritative.
    _sh_match = _ETSY_SALE_HEADER_QTY_RE.search(clean_text)
    if _sh_match:
        _sh_count = int(_sh_match.group(1))
        _item_qty_re = re.compile(r"\bquantity\s*[:]\s*(\d+)\b", re.IGNORECASE)
        _summed = sum(int(m.group(1)) for m in _item_qty_re.finditer(clean_text))
        if _summed > 0 and _sh_count != _summed:
            print(
                f"[QTY_CONFLICT_WARNING] sale_header_count={_sh_count}"
                f" summed_item_qty={_summed} — multi-item order detected;"
                f" sale-header value is authoritative",
                file=sys.stderr,
                flush=True,
            )

    _log_field_decision_proof(path, "quantity", quantity_candidates, quantity_decision, 5.0)
    _log_field_decision_proof(path, "price", price_candidates, price_decision, 8.0)
    _log_field_decision_proof(path, "order_number", order_candidates, order_decision, 10.0)
    _log_field_decision_proof(path, "order_date", date_candidates, date_decision, 10.0)
    _log_field_decision_proof(path, "buyer_email", email_candidates, email_decision, 6.5)
    _log_field_decision_proof(path, "ship_by", ship_by_candidates, ship_by_decision, 8.0)
    _log_field_decision_proof(path, "buyer_name", name_candidates, name_decision, 8.0)
    _log_field_decision_proof(path, "shipping_address", addr_candidates, addr_decision, 7.0)

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

    decision_rows = _apply_assignment_locks(decision_rows, assignment_lock, clean_text)

    # =========================
    # REPLAY (FINAL STEP)
    # =========================

    if ENABLE_REPLAY:
        for field, value in replay_data.items():
            if field in {"quantity", "price"}:
                continue
            # Skip replay for fields locked by a user-assigned span — injection
            # already placed the authoritative candidate; replay would only
            # corrupt it with value-only text search.
            if assignment_locked.get(field):
                continue
            if assignment_lock and field in assignment_lock:
                continue

            # Structural validity gate — never replay structurally-invalid values.
            # Use a lightweight proxy candidate to run the check.
            class _ReplayProxy:
                def __init__(self, v):
                    self.value = v
                    self.segment_text = ""
                    self.left_context = ""
            if not _is_structurally_valid(_ReplayProxy(value), field):
                print(
                    f"[VALIDITY_GATE] replay skipped field={field!r} value={value!r}"
                    f" — failed structural validity",
                    file=sys.stderr, flush=True,
                )
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
        c.id: (
            build_price_signature(c, segment_map, segments)
            if c.field_type == "price"
            else build_shipping_address_signature(c, segment_map)
            if c.field_type == "shipping_address"
            else build_extraction_signature(c, segment_map)
        )
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
            if _row.field == "price" and any("rejected_price_structure" in signal for signal in _row.provenance.get("signals", [])):
                continue
            if _row.field in _already_promoted:
                # Re-check structural validity before re-applying promotion.
                _cand_recheck = next(
                    (c for c in all_candidates if c.id == _row.candidate_id), None
                )
                if _cand_recheck is not None and not _is_structurally_valid(
                    _cand_recheck, _row.field
                ):
                    print(
                        f"[VALIDITY_GATE] re-apply skipped field={_row.field!r}"
                        f" value={_row.value!r} — failed structural validity",
                        file=sys.stderr, flush=True,
                    )
                    continue
                _row.decision = "assigned"
                _row.decision_source = "confidence_promotion"
                _row.provenance["streak_count"] = _row.provenance.get("streak_count", 0)
                print(
                    f"CONF_PROMOTION_OVERRIDE {{ field: {_row.field!r}, forced: true }}",
                    file=sys.stderr, flush=True,
                )
                print(
                    f"[CONF_DEBUG] re-applied promotion field={_row.field!r} (streak already met)",
                    file=sys.stderr, flush=True,
                )
    else:
        for _row in decision_rows:
            if _row.decision == "suggested":
                pass  # always eligible
            elif (
                _row.field in _CONF_ALLOW_ASSIGNED_STREAK
                and _row.decision == "assigned"
                and _row.decision_source not in {"confidence_promotion", "learned"}
            ):
                pass  # header/anchor-assigned date fields also build streaks
            else:
                continue
            if _row.field == "price" and any("rejected_price_structure" in signal for signal in _row.provenance.get("signals", [])):
                continue

            if _row.field == "quantity":
                # Quantity uses the richer context-anchored signature.
                # If the signature is too generic (returns None), skip confidence
                # tracking entirely for this parse — no streak increment, no promotion.
                _qty_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _qty_cand is None:
                    continue
                # Structural validity gate — sale-header candidates are
                # explicitly ALLOWED; bare generic values without anchor are
                # blocked.  See _is_structurally_valid for full rules.
                if not _is_structurally_valid(_qty_cand, "quantity"):
                    print(
                        f"[VALIDITY_GATE] quantity value={_row.value!r} failed structural"
                        f" validity — skipping streak",
                        file=sys.stderr, flush=True,
                    )
                    continue
                _sig = build_quantity_signature(_qty_cand, segment_map, clean_text)
                if _sig is None:
                    print(
                        f"[CONF_DEBUG] quantity sig too generic — skipping streak for value={_row.value!r}",
                        file=sys.stderr, flush=True,
                    )
                    continue
            else:
                # All other fields: structural validity gate before streak.
                _cand_for_validity = next(
                    (c for c in all_candidates if c.id == _row.candidate_id), None
                )
                if _cand_for_validity is not None and not _is_structurally_valid(
                    _cand_for_validity, _row.field
                ):
                    print(
                        f"[VALIDITY_GATE] field={_row.field!r} value={_row.value!r}"
                        f" failed structural validity — skipping streak",
                        file=sys.stderr, flush=True,
                    )
                    continue
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
                _row.provenance["streak_count"] = _streak
                print(
                    f"CONF_PROMOTION_OVERRIDE {{ field: {_row.field!r}, forced: true }}",
                    file=sys.stderr, flush=True,
                )

    decision_rows = _apply_assignment_locks(decision_rows, assignment_lock, clean_text)

    meta: Dict[str, Any] = {}
    gift_attention = _collect_gift_attention_ranges(clean_text)
    if gift_attention["gift_attention_ranges"]:
        meta["gift_attention_ranges"] = gift_attention["gift_attention_ranges"]

    flags = {
        "gift": bool(gift_attention["gift"]),
        "gift_wrap": bool(gift_attention["gift_wrap"]),
        "gift_message": bool(gift_attention["gift_message"]),
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
        elif row.decision_source == "manual_override":
            validated_decisions.append(row)
        elif clean_text[row.start:row.end] == row.value:
            validated_decisions.append(row)

    _log_decision_rows_diff(path, validated_decisions)

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
