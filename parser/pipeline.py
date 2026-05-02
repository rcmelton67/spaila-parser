from typing import List, Dict, Any, Optional as _Opt
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from .ingest import load_eml
from .sanitize import sanitize
from .segment import segment
from .extract import (
    extract_numbers,
    extract_dates,
    extract_header_date,
    extract_order_date_from_subject,
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
from .order_number_safety import (
    GENERIC_NUMBER_SIGNATURES,
    has_address_or_postal_context,
    has_explicit_order_support,
    is_safe_order_number_candidate,
    order_number_safety_reasons,
)
from .replay.fingerprint import compute_template_id, compute_template_family_id, normalize_for_family, normalize_for_family
from .replay.load import load_replay
from .anchors.match import apply_anchor_scoring, compute_anchor_match
from .learning.store import load_assignments, load_records, load_shipping_address_line_type_assignments, load_structural_rules, load_structural_trust, update_structural_trust
from .learning.confidence_store import CONFIDENCE_PROMOTION_THRESHOLD, update_streak, get_currently_promoted_fields, get_promoted_signature_records
from .structural_rules import (
    GENERIC_HARD_LOCK_SIGNATURES,
    classify_role,
    rule_matches_candidate,
    structural_signature,
)

ENABLE_REPLAY = True
TRUST_REPORT_DIR = Path("parser/debug/trust_reports")
TRUST_REPORT_SCHEMA_VERSION = 1
TRUST_REPORT_FIELD_VERSION = "parser_trust_field_v1"
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


def _order_number_label_context(candidate) -> str:
    if has_explicit_order_support(candidate):
        return "explicit_order_label"
    return _infer_label_key(candidate)


def _order_number_segment_type(candidate, segment_map: Dict) -> str:
    text = " ".join([
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ]).lower()
    if has_explicit_order_support(candidate):
        return "order_header"
    if any(token in text for token in ("shipping address", "billing address", "ship to", "bill to")):
        return "address_block"
    if any(token in text for token in ("subtotal", "total", "tax", "shipping:", "$")):
        return "pricing"
    seg = segment_map.get(candidate.segment_id) if getattr(candidate, "segment_id", "") else None
    return _infer_segment_role(getattr(candidate, "segment_text", "") or (seg.text if seg else ""))


def _order_number_position_class(candidate, segment_map: Dict) -> str:
    seg = segment_map.get(candidate.segment_id) if getattr(candidate, "segment_id", "") else None
    if seg is not None:
        if seg.line_index <= 3:
            return "early_header"
        if seg.line_index <= 10:
            return "early_body"
        return "body"
    start = getattr(candidate, "start", None)
    if isinstance(start, int):
        if start < 250:
            return "early_header"
        if start < 1000:
            return "early_body"
    return "unknown_position"


def build_order_number_confidence_signature(candidate, segment_map: Dict) -> str:
    """Build a structural confidence signature for safe order-number candidates.

    Unsafe or generic candidates deliberately retain the legacy 3-part
    signature so existing quarantine rules continue to block promotion.
    """
    old_signature = build_extraction_signature(candidate, segment_map)
    if not is_safe_order_number_candidate(candidate, old_signature):
        return old_signature

    role = classify_role("order_number", candidate)
    if role != "order_header_number":
        return old_signature

    extractor = candidate.extractor or "unknown"
    label = _order_number_label_context(candidate)
    segment_type = _order_number_segment_type(candidate, segment_map)
    position = _order_number_position_class(candidate, segment_map)
    return f"{extractor}|{label}|{segment_type}|{role}|{position}"


def _order_number_confidence_signature_trace(candidate, segment_map: Dict) -> Dict[str, Any]:
    old_signature = build_extraction_signature(candidate, segment_map)
    new_signature = build_order_number_confidence_signature(candidate, segment_map)
    safety_reasons = order_number_safety_reasons(candidate, old_signature)
    role = classify_role("order_number", candidate)
    structural_sig = structural_signature("order_number", candidate)
    upgraded = new_signature != old_signature
    legacy_generic = old_signature in GENERIC_NUMBER_SIGNATURES
    return {
        "field": "order_number",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": role,
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and role == "order_header_number" and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded and new_signature not in GENERIC_NUMBER_SIGNATURES,
        "quarantine_reason": (
            "legacy_generic_numeric_signature"
            if not upgraded and legacy_generic else
            "failed_order_number_safety"
            if safety_reasons else
            ""
        ),
    }


def _order_number_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List,
    confidence_signature: str,
) -> str:
    role = classify_role("order_number", candidate)
    if role != "order_header_number":
        return "role_not_order_header_number"

    safety_reasons = order_number_safety_reasons(candidate, confidence_signature)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)

    if confidence_signature in GENERIC_NUMBER_SIGNATURES:
        return "generic_numeric_signature"

    structural_sig = structural_signature("order_number", candidate)
    trust_records = load_structural_trust("order_number", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != role:
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"

    for other in candidates:
        if other.id == candidate.id:
            continue
        if other.value == candidate.value:
            continue
        if getattr(other, "score", 0.0) < getattr(candidate, "score", 0.0):
            continue
        other_sig = build_order_number_confidence_signature(other, {})
        if classify_role("order_number", other) == "order_header_number" and is_safe_order_number_candidate(other, other_sig):
            return f"ambiguous_safe_competitor:{other.id}"

    return ""


def _promote_order_number_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List,
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("order_number", candidate)
    block_reason = _order_number_trust_block_reason(
        template_id,
        candidate,
        candidates,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        print(
            "[SAFE_NUMERIC_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "order_number",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "order_number",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": classify_role("order_number", candidate),
            "source": "safe_numeric_maturation",
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_numeric_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[SAFE_NUMERIC_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "order_number",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "why_promoted": "safe_numeric_structural_maturity",
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


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
_ORDER_HEADER_ITEM_COUNT_RE = re.compile(
    r"\b(?:sale of|you sold|new order for|order contains|order has|items? ordered)\s+(\d+)\s+items?\b",
    re.IGNORECASE,
)
_QUANTITY_MARKETING_RE = re.compile(
    r"\b(?:over|above|minimum|at least|or more|orders? of|minimum order|bulk discount|"
    r"buy\s+\d+|save|coupon|promo|promotion)\b",
    re.IGNORECASE,
)
_QUANTITY_PRICE_CONTEXT_RE = re.compile(
    r"[$]\s*\d|\b(?:price|subtotal|total|tax|shipping|discount|fee|payment|balance|refund)\b",
    re.IGNORECASE,
)
_QUANTITY_SKU_CONTEXT_RE = re.compile(
    r"\b(?:sku|product\s+id|item\s+id|listing\s+id|model|part\s+#|serial|reference)\b",
    re.IGNORECASE,
)
_QUANTITY_EXPLICIT_MARKER_RE = re.compile(r"\b(?:qty|quantity)\b|(?:^|\s)[x×]\s*\d+\b", re.IGNORECASE)
_QUANTITY_DIMENSION_CONTEXT_RE = re.compile(
    r"\d+\s*(?:\"|inches?\b|inch\b|cm\b|mm\b|ft\b|feet\b|oz\b|lbs?\b|pounds?\b)",
    re.IGNORECASE,
)
_QUANTITY_ADDRESS_CONTEXT_RE = re.compile(
    r"\b(?:shipping address|billing address|ship to|bill to|city|state|zip|postal|address)\b",
    re.IGNORECASE,
)
_QUANTITY_PHONE_RE = re.compile(r"^\+?\d{10,15}$")
_QUANTITY_SAFE_ROLES = {"line_item_quantity", "order_header_item_count"}

_SHIP_BY_LABEL_RE = re.compile(
    r"\b(?:ship\s*by|ships\s*by|dispatch\s*by|estimated\s+ship(?:\s+date)?)\b",
    re.IGNORECASE,
)
_SHIP_BY_DISPATCH_RE = re.compile(r"\bdispatch\s*by\b", re.IGNORECASE)
_SHIP_BY_ESTIMATED_SHIP_RE = re.compile(r"\bestimated\s+ship(?:\s+date)?\b", re.IGNORECASE)
_SHIP_BY_DELIVERY_RE = re.compile(
    r"\b(?:deliver(?:y)?|delivered|arrive|arrives|arrival|estimated\s+delivery|delivery\s+estimate)\b",
    re.IGNORECASE,
)
_SHIP_BY_ORDER_DATE_RE = re.compile(r"\b(?:order\s+date|ordered\s+on|created|placed)\b", re.IGNORECASE)
_SHIP_BY_PAYMENT_RE = re.compile(r"\b(?:paid|payment|charged|invoice\s+date)\b", re.IGNORECASE)
_SHIP_BY_TRACKING_RE = re.compile(r"\b(?:tracking|tracked|label\s+created|carrier|scan|in\s+transit)\b", re.IGNORECASE)
_SHIP_BY_FOOTER_RE = re.compile(r"\b(?:browser|unsubscribe|support|help|contact|privacy|terms)\b", re.IGNORECASE)
_SHIP_BY_HEADER_RE = re.compile(r"^\s*(?:date|sent|from|to|subject)\s*:", re.IGNORECASE)
_SHIP_BY_MONTH_DAY_RE = re.compile(r"^[A-Za-z]{3,9}\s+\d{1,2}$", re.IGNORECASE)

_ORDER_DATE_EXPLICIT_RE = re.compile(
    r"\b(?:order\s+date|ordered\s+on|order\s+placed|placed\s+on|"
    r"purchase\s+date|purchased\s+on)\b",
    re.IGNORECASE,
)
_ORDER_DATE_SUMMARY_RE = re.compile(
    r"\b(?:order\s+summary|order\s+details|order\s+#|order\s+number|new\s+order)\b",
    re.IGNORECASE,
)
_ORDER_DATE_NEARBY_SUMMARY_RE = re.compile(
    r"\b(?:order\s+summary|order\s+details|new\s+order)\b",
    re.IGNORECASE,
)
_ORDER_DATE_SHIP_BY_RE = re.compile(
    r"\b(?:ship\s*by|ships\s*by|dispatch\s*by|estimated\s+ship(?:\s+date)?)\b",
    re.IGNORECASE,
)
_ORDER_DATE_DELIVERY_RE = re.compile(
    r"\b(?:deliver(?:y)?|delivered|arrive|arrives|arrival|estimated\s+delivery|delivery\s+estimate)\b",
    re.IGNORECASE,
)
_ORDER_DATE_PAYMENT_RE = re.compile(r"\b(?:paid|payment|charged|transaction\s+date)\b", re.IGNORECASE)
_ORDER_DATE_TRACKING_RE = re.compile(
    r"\b(?:tracking|tracked|label\s+created|carrier|scan|in\s+transit)\b",
    re.IGNORECASE,
)
_ORDER_DATE_FOOTER_RE = re.compile(
    r"\b(?:browser|unsubscribe|support|help|contact|privacy|terms)\b",
    re.IGNORECASE,
)
_ORDER_DATE_INVOICE_RE = re.compile(r"\b(?:invoice\s+due|due\s+date|due\s+by)\b", re.IGNORECASE)
_ORDER_DATE_HEADER_RE = re.compile(r"^\s*(?:date|sent)\s*:", re.IGNORECASE)
_ORDER_DATE_SAFE_ROLES = {
    "explicit_order_date",
    "subject_order_event_date",
    "order_summary_date",
    "metadata_fallback_date",
}
_ORDER_DATE_UNSAFE_ROLES = {
    "ship_by_date",
    "delivery_date",
    "payment_date",
    "tracking_date",
    "footer_date",
    "invoice_due_date",
    "generic_unlabeled_date",
}

_EMAIL_SYSTEM_LOCAL_RE = re.compile(
    r"^(?:no[-_]?reply|do[-_]?not[-_]?reply|noreply|notification|notifications|automated|mailer|daemon|bounce|"
    r"postmaster|robot|system|updates?)$",
    re.IGNORECASE,
)
_EMAIL_SUPPORT_LOCAL_RE = re.compile(r"^(?:support|help|contact|service|info|admin|sales|orders?|team)$", re.IGNORECASE)
_EMAIL_SELLER_CONTEXT_RE = re.compile(r"\b(?:seller|store|shop|merchant|vendor|from\s*:|sold\s+by|reply\s+to)\b", re.IGNORECASE)
_EMAIL_CUSTOMER_CONTEXT_RE = re.compile(r"\b(?:customer|buyer|recipient|purchaser)\b", re.IGNORECASE)
_EMAIL_CONTACT_CONTEXT_RE = re.compile(r"\b(?:customer\s+contact|buyer\s+contact|recipient\s+contact|contact\s+email)\b", re.IGNORECASE)
_EMAIL_GUEST_CONTACT_RE = re.compile(
    r"\b(?:guest|send\s+(?:them|buyer|customer|recipient)\s+an\s+email|"
    r"customer\s+contact|buyer\s+contact|recipient\s+contact)\b",
    re.IGNORECASE,
)
_EMAIL_BILLING_CONTEXT_RE = re.compile(r"\bbilling\b", re.IGNORECASE)
_EMAIL_SHIPPING_CONTEXT_RE = re.compile(r"\bshipping\b", re.IGNORECASE)
_EMAIL_FOOTER_CONTEXT_RE = re.compile(r"\b(?:unsubscribe|privacy|terms|support|help center|contact us|questions|browser)\b", re.IGNORECASE)
_EMAIL_HEADER_CONTEXT_RE = re.compile(r"^\s*(?:from|to|cc|bcc|reply-to|sender|return-path|subject)\s*:", re.IGNORECASE)
_EMAIL_PLATFORM_CONTEXT_RE = re.compile(r"\b(?:marketplace|notification|automated|transactional|do not reply|no-reply|noreply)\b", re.IGNORECASE)


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
_BUYER_NAME_ACTION_RE = re.compile(
    r"\b(?:purchase\s+shipping\s+label|print\s+shipping\s+label|buy\s+shipping\s+label|"
    r"free\s+shipping|shipping\s+method|payment\s+method|order\s+summary|order\s+details|"
    r"customer\s+note|transaction\s+id|processing\s+time|questions|shop\s+policies)\b",
    re.IGNORECASE,
)
_BUYER_NAME_GENERIC_LABEL_RE = re.compile(
    r"^\s*(?:billing\s+address|shipping\s+address|ship\s+to|deliver\s+to|recipient|"
    r"customer|buyer|name|contact|address|order|product|item|sku|quantity|price)\s*:?\s*$",
    re.IGNORECASE,
)
_BUYER_NAME_PRODUCT_RE = re.compile(
    r"\b(?:product|item|sku|listing|variation|memorial|ornament|grave|marker|"
    r"custom|personalized|engraved|size|color|quantity|qty)\b",
    re.IGNORECASE,
)

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
        signature = getattr(candidate, "learned_signature", "") or getattr(candidate, "signature", "")
        if not is_safe_order_number_candidate(candidate, signature):
            return False

    elif field == "buyer_name":
        if " " not in value and "&" not in value:
            return False
        if len(value) < 4:
            return False
        if value.lower() in _BAD_BUYER_NAME_VALUES:
            return False

    return True


def _buyer_name_label_context(candidate, segments: List[Any]) -> str:
    source = getattr(candidate, "source", "") or ""
    if source in {"shipping", "billing"}:
        return f"{source}_address_label"
    idx = next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)
    if idx is None:
        return "unknown_label"
    for prev in reversed(segments[:idx]):
        lowered = prev.text.lower()
        if any(label in lowered for label in ("shipping address", "billing address", "ship to", "deliver to", "recipient", "customer", "buyer", "contact")):
            return re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")
    return "unknown_label"


def _buyer_name_block_role(candidate, candidates: List[Any] | None = None) -> str:
    source = getattr(candidate, "source", "") or ""
    if source == "shipping":
        return "shipping_recipient_name"
    if source == "billing":
        if candidates and any(getattr(other, "source", "") in {"shipping", "recipient"} for other in candidates):
            return "billing_contact_name_suppressed"
        return "billing_contact_name"
    if source == "recipient":
        return "recipient_name"
    return "contact_name"


def _buyer_name_line_position(candidate, segments: List[Any]) -> str:
    idx = next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)
    if idx is None:
        return "unknown_line"
    label_idx = None
    for i in range(idx - 1, -1, -1):
        lowered = segments[i].text.lower()
        if any(label in lowered for label in ("shipping address", "billing address", "ship to", "deliver to", "recipient", "customer", "buyer", "contact")):
            label_idx = i
            break
    if label_idx is None:
        return "unknown_line"
    offset = idx - label_idx
    if offset == 1:
        return "first_line_after_label"
    return f"line_{offset}_after_label"


def _buyer_name_position_class(candidate, segments: List[Any]) -> str:
    total = max(len(segments), 1)
    idx = next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)
    if idx is None:
        return "unknown_position"
    ratio = idx / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "mid_body"
    return "late_body"


def _buyer_name_variant(candidate) -> str:
    return "normalized_variant" if getattr(candidate, "extractor", "") == "normalized_variant" else "raw_variant"


def _buyer_name_classification(candidate, explicit_acceptance: bool = False) -> str:
    value = (getattr(candidate, "value", "") or "").strip()
    context = " ".join([
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ])
    lowered = value.casefold()
    role = classify_role("buyer_name", candidate)
    if _BUYER_NAME_GENERIC_LABEL_RE.match(value) or role == "label_text" or lowered in _BAD_BUYER_NAME_VALUES:
        return "label_or_action"
    if _BUYER_NAME_ACTION_RE.search(value) or _BUYER_NAME_ACTION_RE.search(context):
        return "label_or_action"
    if _BUYER_NAME_PRODUCT_RE.search(value):
        return "product_like"
    if re.search(r"\b(?:llc|inc|co\.?|company|corp|ltd)\b", value, re.IGNORECASE):
        return "business_recipient"
    if role == "store_name":
        return "store_or_company"
    if role == "shipping_method_text":
        return "shipping_method"
    return "person_name"


def buyer_name_safety_reasons(
    candidate,
    candidates: List[Any],
    segments: List[Any],
    explicit_acceptance: bool = False,
) -> List[str]:
    value = (getattr(candidate, "value", "") or "").strip()
    classification = _buyer_name_classification(candidate, explicit_acceptance)
    block_role = _buyer_name_block_role(candidate, candidates)
    reasons: List[str] = []

    if not value or len(value) < 4:
        reasons.append("too_short")
    if " " not in value and "&" not in value:
        reasons.append("not_contact_like")
    if _BUYER_NAME_GENERIC_LABEL_RE.match(value):
        reasons.append("generic_label")
    if classification in {"label_or_action", "product_like", "shipping_method"}:
        reasons.append(f"unsafe_classification:{classification}")
    if classification == "business_recipient" and not explicit_acceptance:
        reasons.append("business_recipient_without_explicit_acceptance")
    if classification == "store_or_company" and not explicit_acceptance:
        reasons.append("store_or_company_without_explicit_acceptance")
    if block_role == "billing_contact_name_suppressed":
        reasons.append("billing_suppressed_by_shipping_or_recipient")
    if getattr(candidate, "source", "") == "billing" and any(getattr(other, "source", "") in {"shipping", "recipient"} for other in candidates):
        reasons.append("billing_when_better_source_exists")
    if _buyer_name_line_position(candidate, segments) != "first_line_after_label":
        reasons.append("not_first_contact_line")

    return reasons


def is_safe_buyer_name_candidate(
    candidate,
    candidates: List[Any],
    segments: List[Any],
    explicit_acceptance: bool = False,
) -> bool:
    return not buyer_name_safety_reasons(candidate, candidates, segments, explicit_acceptance)


def build_buyer_name_confidence_signature(
    candidate,
    segment_map: Dict,
    segments: List[Any],
    candidates: List[Any] | None = None,
    explicit_acceptance: bool = False,
) -> str:
    old_signature = build_extraction_signature(candidate, segment_map)
    peer_candidates = candidates or [candidate]
    if not is_safe_buyer_name_candidate(candidate, peer_candidates, segments, explicit_acceptance):
        return f"{candidate.extractor or 'unknown'}|none|body"

    extractor = candidate.extractor or "unknown"
    source = getattr(candidate, "source", "") or "unknown_source"
    block_role = _buyer_name_block_role(candidate, peer_candidates)
    label = _buyer_name_label_context(candidate, segments)
    line_position = _buyer_name_line_position(candidate, segments)
    classification = _buyer_name_classification(candidate, explicit_acceptance)
    variant = _buyer_name_variant(candidate)
    position = _buyer_name_position_class(candidate, segments)
    return f"{extractor}|{source}|{block_role}|{label}|{line_position}|{classification}|{variant}|{position}"


def _buyer_name_confidence_signature_trace(
    candidate,
    candidates: List[Any],
    segment_map: Dict,
    segments: List[Any],
    explicit_acceptance: bool = False,
) -> Dict[str, Any]:
    old_signature = build_extraction_signature(candidate, segment_map)
    new_signature = build_buyer_name_confidence_signature(candidate, segment_map, segments, candidates, explicit_acceptance)
    safety_reasons = buyer_name_safety_reasons(candidate, candidates, segments, explicit_acceptance)
    structural_sig = structural_signature("buyer_name", candidate)
    classification = _buyer_name_classification(candidate)
    return {
        "field": "buyer_name",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "source_type": getattr(candidate, "source", ""),
        "block_role": _buyer_name_block_role(candidate, candidates),
        "label_context": _buyer_name_label_context(candidate, segments),
        "line_position": _buyer_name_line_position(candidate, segments),
        "classification": classification,
        "variant": _buyer_name_variant(candidate),
        "position_class": _buyer_name_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": new_signature != old_signature and not safety_reasons,
        "quarantine_reason": "" if not safety_reasons else "failed_buyer_name_safety",
    }


class _OrderNumberRecordProxy:
    def __init__(self, value: str, record: Dict[str, Any] | None = None):
        record = record or {}
        self.value = value
        self.raw_text = record.get("selected_text") or value
        self.segment_text = record.get("segment_text", "") or self.raw_text
        self.left_context = record.get("left_context", "")
        self.right_context = record.get("right_context", "")
        self.extractor = record.get("extractor", "")
        self.learned_signature = record.get("learned_signature", "")


def _order_number_record_is_safe(value: str, record: Dict[str, Any] | None = None) -> bool:
    proxy = _OrderNumberRecordProxy(value, record)
    signature = (record or {}).get("learned_signature", "")
    return is_safe_order_number_candidate(proxy, signature)


def _record_is_generic_hard_lock(record: Dict[str, Any] | None) -> bool:
    record = record or {}
    signature = record.get("learned_signature", "") or record.get("signature", "")
    structural = record.get("structural_signature", "")
    return signature in GENERIC_HARD_LOCK_SIGNATURES or structural in GENERIC_HARD_LOCK_SIGNATURES


def _assignment_record_can_lock(field: str, record: Dict[str, Any]) -> bool:
    if field == "order_number":
        return _order_number_record_is_safe(record.get("value", ""), record)
    return not _record_is_generic_hard_lock(record)


def _log_assignment_blocked(field: str, record: Dict[str, Any], reason: str) -> None:
    print(
        "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
        + json.dumps({
            "field": field,
            "value": record.get("value", ""),
            "signature": record.get("learned_signature", ""),
            "structural_signature": record.get("structural_signature", ""),
            "segment_text": record.get("segment_text", ""),
            "reason": reason,
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )


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
_ADDRESS_ACTION_LINE_RE = re.compile(
    r"\b(?:purchase\s+shipping\s+label|print\s+shipping\s+label|buy\s+shipping\s+label|"
    r"order\s+details|order\s+summary|payment\s+method|order\s+total|item\s+total|"
    r"subtotal|sales\s+tax|questions|shop\s+policies|transaction\s+id|processing\s+time)\b",
    re.IGNORECASE,
)


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


def _shipping_address_position_class(candidate, segments: List[Any]) -> str:
    total = max(len(segments), 1)
    index = next((i for i, seg in enumerate(segments) if seg.id == candidate.segment_id), None)
    if index is None:
        return "unknown_position"
    ratio = index / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "mid_body"
    return "late_body"


def _shipping_address_label_context(candidate, segments: List[Any]) -> str:
    source = getattr(candidate, "source", "") or ""
    if source in {"shipping", "billing"}:
        return f"{source}_address_label"
    relative = _shipping_address_relative_position(candidate, segments)
    return relative.get("previous_label") or "unknown_address_label"


def _shipping_address_block_role(candidate) -> str:
    source = getattr(candidate, "source", "") or ""
    if source == "shipping":
        return "shipping_address_block"
    if source == "billing":
        return "billing_address_block"
    return classify_role("shipping_address", candidate)


def _shipping_address_line_policy(
    candidate,
    selected_start: int | None = None,
    selected_end: int | None = None,
    buyer_name: str = "",
) -> Dict[str, Any]:
    lines = split_shipping_address_candidate_lines(candidate, buyer_name)
    selected_types: List[str] = []
    excluded_types: List[str] = []
    selected_lines: List[Dict[str, Any]] = []
    selected_span = isinstance(selected_start, int) and isinstance(selected_end, int)

    for line in lines:
        line_type = line["type"]
        include = False
        if selected_span and isinstance(line.get("start"), int) and isinstance(line.get("end"), int):
            include = line["start"] < selected_end and selected_start < line["end"]
        elif not selected_span:
            include = line_type in {"street", "city_state_zip"} or (
                line_type == "unknown"
                and selected_lines
                and selected_lines[-1]["type"] == "street"
            )

        target = selected_types if include else excluded_types
        if line_type not in target:
            target.append(line_type)
        if include:
            selected_lines.append(line)

    return {
        "line_types": [line["type"] for line in lines],
        "selected_line_types": selected_types,
        "excluded_line_types": [line_type for line_type in excluded_types if line_type not in selected_types],
        "selected_lines": selected_lines,
        "line_count": len(lines),
        "contains_company": any(line["type"] == "company" for line in lines),
        "contains_country": any(line["type"] == "country" for line in lines),
        "selected_contains_company": "company" in selected_types,
        "selected_contains_country": "country" in selected_types,
        "selected_contains_name": "name" in selected_types,
        "selected_text": "\n".join(line["text"] for line in selected_lines).strip(),
    }


def shipping_address_safety_reasons(
    candidate,
    candidates: List[Any],
    segments: List[Any],
    buyer_name: str = "",
    selected_start: int | None = None,
    selected_end: int | None = None,
    explicit_policy: bool = False,
) -> List[str]:
    source = getattr(candidate, "source", "") or ""
    role = _shipping_address_block_role(candidate)
    policy = _shipping_address_line_policy(candidate, selected_start, selected_end, buyer_name)
    selected_types = set(policy["selected_line_types"])
    selected_text = policy["selected_text"] or getattr(candidate, "value", "") or ""
    reasons: List[str] = []

    if source != "shipping":
        if any(getattr(other, "source", "") == "shipping" for other in candidates):
            reasons.append("billing_block_when_shipping_exists")
        else:
            reasons.append(f"non_shipping_source:{source or 'unknown'}")
    if role == "billing_address_block":
        reasons.append("billing_address_role")
    if not {"street", "city_state_zip"}.issubset(selected_types):
        reasons.append("missing_street_city_state_zip")
    if _ADDRESS_ACTION_LINE_RE.search(selected_text) or _ADDRESS_ACTION_LINE_RE.search(getattr(candidate, "value", "") or ""):
        reasons.append("footer_or_action_text")
    if policy["selected_contains_company"] and not explicit_policy:
        reasons.append("company_selected_without_explicit_policy")
    if policy["selected_contains_country"] and not explicit_policy:
        reasons.append("country_selected_without_explicit_policy")
    if policy["line_count"] > 0 and not policy["selected_lines"]:
        reasons.append("empty_line_policy")
    if policy["line_count"] >= 7 and not explicit_policy:
        reasons.append("unstable_block_boundary")

    return reasons


def is_safe_shipping_address_candidate(
    candidate,
    candidates: List[Any],
    segments: List[Any],
    buyer_name: str = "",
    selected_start: int | None = None,
    selected_end: int | None = None,
    explicit_policy: bool = False,
) -> bool:
    return not shipping_address_safety_reasons(
        candidate,
        candidates,
        segments,
        buyer_name,
        selected_start,
        selected_end,
        explicit_policy,
    )


def build_shipping_address_confidence_signature(
    candidate,
    segment_map: Dict,
    segments: List[Any],
    buyer_name: str = "",
    selected_start: int | None = None,
    selected_end: int | None = None,
    explicit_policy: bool = False,
) -> str:
    old_signature = build_shipping_address_signature(candidate, segment_map)
    if not is_safe_shipping_address_candidate(
        candidate,
        [candidate],
        segments,
        buyer_name,
        selected_start,
        selected_end,
        explicit_policy,
    ):
        return old_signature

    policy = _shipping_address_line_policy(candidate, selected_start, selected_end, buyer_name)
    source = getattr(candidate, "source", "") or "unknown_source"
    role = _shipping_address_block_role(candidate)
    label = _shipping_address_label_context(candidate, segments)
    line_sequence = "-".join(policy["line_types"]) or "none"
    selected = "-".join(policy["selected_line_types"]) or "none"
    excluded = "-".join(policy["excluded_line_types"]) or "none"
    company = "company_included" if policy["selected_contains_company"] else "company_excluded"
    country = "country_included" if policy["selected_contains_country"] else "country_excluded"
    position = _shipping_address_position_class(candidate, segments)
    extractor = candidate.extractor or "unknown"
    return f"{extractor}|{source}|{role}|{line_sequence}|selected:{selected}|excluded:{excluded}|{label}|{company}|{country}|{position}"


def _shipping_address_confidence_signature_trace(
    candidate,
    candidates: List[Any],
    segment_map: Dict,
    segments: List[Any],
    buyer_name: str = "",
    selected_start: int | None = None,
    selected_end: int | None = None,
    explicit_policy: bool = False,
) -> Dict[str, Any]:
    old_signature = build_shipping_address_signature(candidate, segment_map)
    new_signature = build_shipping_address_confidence_signature(
        candidate,
        segment_map,
        segments,
        buyer_name,
        selected_start,
        selected_end,
        explicit_policy,
    )
    policy = _shipping_address_line_policy(candidate, selected_start, selected_end, buyer_name)
    safety_reasons = shipping_address_safety_reasons(
        candidate,
        candidates,
        segments,
        buyer_name,
        selected_start,
        selected_end,
        explicit_policy,
    )
    return {
        "field": "shipping_address",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "source_type": getattr(candidate, "source", ""),
        "block_role": _shipping_address_block_role(candidate),
        "line_type_sequence": policy["line_types"],
        "selected_line_types": policy["selected_line_types"],
        "excluded_line_types": policy["excluded_line_types"],
        "label_context": _shipping_address_label_context(candidate, segments),
        "company_inclusion": policy["selected_contains_company"],
        "country_inclusion": policy["selected_contains_country"],
        "position_class": _shipping_address_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": new_signature != old_signature and not safety_reasons,
        "quarantine_reason": "" if not safety_reasons else "failed_shipping_address_safety",
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
_ITEM_PRICE_SAFE_LABELS = {"item_price", "product"}
_PRICE_UNSAFE_TYPES = {
    "order_total",
    "item_total",
    "subtotal",
    "tax",
    "shipping",
    "discount",
    "fee",
    "fees",
    "aggregate_total",
    "unknown_price",
}
_PRICE_INTEGER_RE = re.compile(r"^\d+$")
_PRICE_DECIMAL_RE = re.compile(r"^\d{1,6}(?:[.,]\d{2})$")
_PRICE_DATE_CONTEXT_RE = re.compile(
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|"
    r"january|february|march|april|june|july|august|september|october|november|december|"
    r"date|ship\s+by|ordered|created|paid)\b",
    re.IGNORECASE,
)


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


def _price_position_class(candidate, segments: List[Any]) -> str:
    total = max(len(segments), 1)
    idx = _price_candidate_index(candidate, segments)
    if idx is None:
        return "unknown_position"
    ratio = idx / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "mid_body"
    return "late_body"


def _price_item_context(candidate, segments: List[Any]) -> str:
    idx = _price_candidate_index(candidate, segments)
    if idx is None:
        context = " ".join([
            candidate.segment_text or "",
            candidate.left_context or "",
            candidate.right_context or "",
        ]).lower()
    else:
        window = segments[max(0, idx - 3): idx + 4]
        context = " ".join(seg.text for seg in window).lower()

    if any(token in context for token in ("sku", "product", "item", "listing", "variation")):
        return "item_row"
    if any(token in context for token in ("qty", "quantity", "each", "unit price", "price")):
        return "line_item"
    return "none"


def _price_line_item_structure(candidate, segments: List[Any]) -> str:
    label = _price_nearby_label(candidate, segments)
    section = _price_section_type(candidate, segments)
    item_context = _price_item_context(candidate, segments)
    if label in _ITEM_PRICE_SAFE_LABELS and section == "item":
        return "line_item"
    if item_context in {"item_row", "line_item"} and section == "item":
        return "line_item"
    if section == "summary" or label in _PRICE_AGGREGATE_LABELS:
        return "summary"
    return "unknown_structure"


def _price_candidate_has_currency_context(candidate) -> bool:
    context = " ".join([
        getattr(candidate, "raw_text", "") or "",
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ])
    return "$" in context or bool(re.search(r"\b(?:usd|cad|eur|gbp)\b", context, re.IGNORECASE))


def item_price_safety_reasons(candidate, segments: List[Any], segment_map: Dict) -> List[str]:
    value = (getattr(candidate, "value", "") or "").strip().replace(",", ".")
    label = _price_nearby_label(candidate, segments)
    price_type = classify_price_type(candidate, segments)
    context_class = _price_context_class(candidate, segments)
    section = _price_section_type(candidate, segments)
    line_structure = _price_line_item_structure(candidate, segments)
    context = " ".join([
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ])
    reasons: List[str] = []

    if price_type != "item_price":
        reasons.append(f"price_type_not_item_price:{price_type}")
    if context_class != "item_price":
        reasons.append(f"context_not_item_price:{context_class}")
    if label not in _ITEM_PRICE_SAFE_LABELS:
        reasons.append(f"unsafe_label:{label}")
    if section != "item":
        reasons.append(f"unsafe_section:{section}")
    if line_structure != "line_item":
        reasons.append(f"unsafe_line_structure:{line_structure}")
    if label in _PRICE_AGGREGATE_LABELS or price_type in _PRICE_UNSAFE_TYPES or context_class in _PRICE_UNSAFE_TYPES:
        reasons.append("aggregate_summary_price")
    if _PRICE_INTEGER_RE.fullmatch(value):
        reasons.append("quantity_like_integer")
    if not _PRICE_DECIMAL_RE.fullmatch(value):
        reasons.append("not_currency_decimal")
    if not _price_candidate_has_currency_context(candidate):
        reasons.append("missing_currency_context")
    if has_explicit_order_support(candidate):
        reasons.append("order_number_context")
    if has_address_or_postal_context(candidate):
        reasons.append("address_or_postal_context")
    if _PRICE_DATE_CONTEXT_RE.search(context):
        reasons.append("date_context")

    role = classify_role("price", candidate)
    if role in {"order_number", "zip", "quantity", "tax", "shipping", "discount", "subtotal", "aggregate_total"}:
        reasons.append(f"role_blocked:{role}")

    return reasons


def is_safe_item_price_candidate(candidate, segments: List[Any], segment_map: Dict) -> bool:
    return not item_price_safety_reasons(candidate, segments, segment_map)


def build_item_price_confidence_signature(candidate, segment_map: Dict, segments: List[Any]) -> str:
    """Build a structural confidence signature for safe item-price candidates.

    Unsafe price candidates deliberately retain the legacy signature so totals,
    tax, shipping, discounts, and generic body prices cannot become structural
    authority for item_price.
    """
    old_signature = build_price_signature(candidate, segment_map, segments)
    if not is_safe_item_price_candidate(candidate, segments, segment_map):
        return old_signature

    extractor = candidate.extractor or "unknown"
    price_type = classify_price_type(candidate, segments)
    item_context = _price_item_context(candidate, segments)
    line_structure = _price_line_item_structure(candidate, segments)
    nearby_label = _price_nearby_label(candidate, segments)
    section = _price_section_type(candidate, segments)
    position = _price_position_class(candidate, segments)
    return f"{extractor}|{price_type}|{item_context}|{line_structure}|{nearby_label}|{section}|{position}"


def _item_price_confidence_signature_trace(candidate, segment_map: Dict, segments: List[Any]) -> Dict[str, Any]:
    old_signature = build_price_signature(candidate, segment_map, segments)
    new_signature = build_item_price_confidence_signature(candidate, segment_map, segments)
    safety_reasons = item_price_safety_reasons(candidate, segments, segment_map)
    role = classify_role("price", candidate)
    structural_sig = structural_signature("price", candidate)
    upgraded = new_signature != old_signature
    return {
        "field": "price",
        "target_subtype": "item_price",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": role,
        "price_type": classify_price_type(candidate, segments),
        "nearby_label": _price_nearby_label(candidate, segments),
        "section_type": _price_section_type(candidate, segments),
        "line_item_structure": _price_line_item_structure(candidate, segments),
        "positional_trust": _price_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and role == "item_price" and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded,
        "quarantine_reason": "" if not safety_reasons else "failed_item_price_safety",
    }


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


_TRUST_REPORT_FIELDS = (
    "order_number",
    "item_price",
    "shipping_address",
    "buyer_name",
    "quantity",
    "ship_by",
    "buyer_email",
    "order_date",
)
_TRUST_REPORT_FIELD_MAP = {
    "item_price": "price",
}
_TRUST_REPORT_CANDIDATE_TYPES = {
    "order_number": {"number", "order_number"},
    "item_price": {"price"},
    "shipping_address": {"shipping_address"},
    "buyer_name": {"buyer_name"},
    "quantity": {"number", "quantity"},
    "ship_by": {"ship_by"},
    "buyer_email": {"email", "buyer_email"},
    "order_date": {"date"},
}


def _report_parser_field(report_field: str) -> str:
    return _TRUST_REPORT_FIELD_MAP.get(report_field, report_field)


def _report_candidate_types(report_field: str) -> set:
    return _TRUST_REPORT_CANDIDATE_TYPES.get(report_field, {report_field})


def _safe_round(value: Any, digits: int = 4) -> float:
    try:
        return round(float(value), digits)
    except Exception:
        return 0.0


def _trust_report_parse_run_id(
    path: str,
    clean_text: str,
    template_id: str,
    template_family_id: str,
    decision_rows: List[DecisionRow],
) -> str:
    decision_fingerprint = [
        {
            "field": row.field,
            "value": row.value,
            "decision": row.decision,
            "decision_source": row.decision_source,
            "candidate_id": row.candidate_id,
            "start": row.start,
            "end": row.end,
        }
        for row in sorted(decision_rows, key=lambda item: (item.field, item.candidate_id))
    ]
    payload = json.dumps({
        "path": str(Path(path)),
        "clean_text_hash": hashlib.sha256(clean_text.encode("utf-8", errors="ignore")).hexdigest(),
        "template_id": template_id,
        "template_family_id": template_family_id,
        "decisions": decision_fingerprint,
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _candidate_confidence_signature(
    report_field: str,
    candidate: Candidate,
    segment_map: Dict,
    segments: List[Any],
    all_candidates: List[Candidate],
    clean_text: str,
) -> str:
    parser_field = _report_parser_field(report_field)
    if parser_field == "price":
        return build_item_price_confidence_signature(candidate, segment_map, segments)
    if parser_field == "shipping_address":
        return build_shipping_address_confidence_signature(candidate, segment_map, segments)
    if parser_field == "order_number":
        return build_order_number_confidence_signature(candidate, segment_map)
    if parser_field == "ship_by":
        return build_ship_by_confidence_signature(candidate, segment_map, segments)
    if parser_field == "buyer_email":
        return build_buyer_email_confidence_signature(candidate, segment_map, segments, all_candidates)
    if parser_field == "quantity":
        return build_quantity_confidence_signature(candidate, segment_map, segments, clean_text)
    if parser_field == "order_date":
        date_candidates = [c for c in all_candidates if getattr(c, "field_type", "") == "date"]
        return build_order_date_confidence_signature(candidate, segment_map, segments, date_candidates)
    if parser_field == "buyer_name":
        return build_buyer_name_confidence_signature(candidate, segment_map, segments, all_candidates)
    return build_extraction_signature(candidate, segment_map)


def _candidate_block_reasons(candidate: Candidate) -> List[str]:
    reasons: List[str] = []
    provenance = getattr(candidate, "provenance_extra", {}) or {}
    why_not = str(provenance.get("why_not_assigned") or "").strip()
    if why_not:
        reasons.extend([part for part in why_not.split(",") if part])
    for penalty in getattr(candidate, "penalties", []) or []:
        if "safety" in penalty or "gate" in penalty or "blocked" in penalty or "-inf" in penalty:
            reasons.append(str(penalty))
    return list(dict.fromkeys(reasons))


def _candidate_safety(candidate: Candidate, block_reasons: List[str]) -> Dict[str, Any]:
    passed = not block_reasons and _safe_round(getattr(candidate, "score", 0.0)) > -999
    passed_gates = ["span_contract"]
    if passed:
        passed_gates.append("field_safety")
    return {
        "passed": passed,
        "passed_gates": passed_gates,
        "failed_gates": [] if passed else (block_reasons or ["candidate_blocked"]),
    }


def _matching_trust_record(
    parser_field: str,
    candidate: _Opt[Candidate],
    structural_sig: str,
    confidence_sig: str,
    template_family_id: str,
) -> Dict[str, Any]:
    if not parser_field:
        return {}
    try:
        records = load_structural_trust(parser_field, template_family_id)
    except Exception:
        return {}
    role = classify_role(parser_field, candidate) if candidate is not None else ""
    for record in records:
        if structural_sig and record.get("structural_signature") == structural_sig:
            return record
        if confidence_sig and record.get("learned_signature") == confidence_sig:
            return record
        if role and record.get("role") == role and record.get("adaptive_family") == template_family_id:
            return record
    return {}


def _report_competing_candidates(
    report_field: str,
    selected_candidate_id: str,
    candidates: List[Candidate],
    segment_map: Dict,
    segments: List[Any],
    all_candidates: List[Candidate],
    clean_text: str,
) -> List[Dict[str, Any]]:
    parser_field = _report_parser_field(report_field)
    rows = []
    for candidate in sorted(
        candidates,
        key=lambda c: (-float(getattr(c, "score", 0.0) or 0.0), c.start if c.start is not None else 10**9),
    )[:12]:
        structural_sig = structural_signature(parser_field, candidate)
        confidence_sig = _candidate_confidence_signature(report_field, candidate, segment_map, segments, all_candidates, clean_text)
        block_reasons = _candidate_block_reasons(candidate)
        safety = _candidate_safety(candidate, block_reasons)
        rows.append({
            "candidate_id": candidate.id,
            "value": candidate.value,
            "extractor": candidate.extractor,
            "source": getattr(candidate, "source", ""),
            "score": _safe_round(getattr(candidate, "score", 0.0)),
            "structural_signature": structural_sig,
            "confidence_signature": confidence_sig,
            "safety_passed": safety["passed"],
            "block_reasons": block_reasons,
            "winner": bool(selected_candidate_id and candidate.id == selected_candidate_id),
        })
    return rows


def _build_field_trust_report(
    report_field: str,
    decision: _Opt[DecisionRow],
    candidates: List[Candidate],
    all_candidates: List[Candidate],
    segments: List[Any],
    segment_map: Dict,
    clean_text: str,
    template_family_id: str,
    update_confidence: bool,
) -> Dict[str, Any]:
    parser_field = _report_parser_field(report_field)
    selected_candidate = next((c for c in all_candidates if decision and c.id == decision.candidate_id), None)
    selected_structural_sig = decision.provenance.get("trust_signature", "") if decision else ""
    selected_confidence_sig = decision.provenance.get("confidence_signature", "") if decision else ""
    if selected_candidate is not None:
        selected_structural_sig = selected_structural_sig or structural_signature(parser_field, selected_candidate)
        selected_confidence_sig = selected_confidence_sig or _candidate_confidence_signature(
            report_field,
            selected_candidate,
            segment_map,
            segments,
            all_candidates,
            clean_text,
        )
    trust = _matching_trust_record(
        parser_field,
        selected_candidate,
        selected_structural_sig,
        selected_confidence_sig,
        template_family_id,
    )
    block_reasons = []
    if decision:
        why_not = str(decision.provenance.get("why_not_assigned") or decision.provenance.get("why_not_promoted") or "").strip()
        if why_not:
            block_reasons.extend([part for part in why_not.split(",") if part])
    if selected_candidate is not None:
        block_reasons.extend(_candidate_block_reasons(selected_candidate))
    block_reasons = list(dict.fromkeys(block_reasons))
    competing = _report_competing_candidates(
        report_field,
        decision.candidate_id if decision else "",
        candidates,
        segment_map,
        segments,
        all_candidates,
        clean_text,
    )
    safety_passed = bool(decision) and not block_reasons
    if selected_candidate is not None:
        safety_passed = _candidate_safety(selected_candidate, block_reasons)["passed"]
    active_rejection = _field_is_rejected(template_family_id, parser_field)
    decision_source = decision.decision_source if decision else ""
    is_replay = "replay" in decision_source
    structural_trust_updated = bool(decision and "maturity_promotion" in decision_source)
    timezone_provenance = {}
    if parser_field == "order_date" and decision:
        timezone_keys = (
            "raw_header_date",
            "parsed_header_datetime",
            "source_timezone",
            "business_timezone_used",
            "final_calendar_date",
            "timezone_adjustment_reason",
        )
        timezone_provenance = {
            key: decision.provenance.get(key, "")
            for key in timezone_keys
            if decision.provenance.get(key, "") != ""
        }
    return {
        "field": report_field,
        "parser_field": parser_field,
        "field_version": TRUST_REPORT_FIELD_VERSION,
        "family_trust_scope": {
            "scope": "template_family",
            "template_family_id": template_family_id,
        },
        "unlearn_status": {
            "active_rejection": active_rejection,
            "status": "rejected" if active_rejection else "active",
        },
        "final_value": "" if decision is None or decision.value is None else str(decision.value),
        "decision": decision.decision if decision else "missing",
        "decision_source": decision_source if decision else "missing",
        "confidence": _safe_round(decision.confidence if decision else 0.0),
        "candidate_id": decision.candidate_id if decision else "",
        "start": decision.start if decision else None,
        "end": decision.end if decision else None,
        "snippet": decision.provenance.get("snippet", "") if decision else "",
        "structural_signature": selected_structural_sig,
        "confidence_signature": selected_confidence_sig,
        "trust_state": (
            decision.provenance.get("trust_state")
            or decision.provenance.get("trust_state_transition")
            or trust.get("trust_state")
            or "none"
        ) if decision else (trust.get("trust_state") or "none"),
        "trust_score": _safe_round(trust.get("trust_score", 0.0)),
        "replay_source": decision_source if is_replay else "",
        "maturity_state": decision.provenance.get("maturity_state", "") if decision else "missing",
        "why_assigned": decision.provenance.get("why_assigned", "") if decision else "",
        "why_not_assigned": decision.provenance.get("why_not_assigned", "") if decision else "missing_final_decision",
        "block_reasons": block_reasons,
        "safety": {
            "passed": safety_passed,
            "passed_gates": ["span_contract", "field_safety"] if safety_passed else ["span_contract"],
            "failed_gates": [] if safety_passed else (block_reasons or ["missing_final_decision"]),
        },
        "competing_candidates": competing,
        "learning": {
            "confidence_updated": bool(update_confidence),
            "confidence_streak_count": int(decision.provenance.get("streak_count", 0)) if decision else 0,
            "structural_trust_updated": structural_trust_updated,
            "store_scope": "template_family",
        },
        "timezone_provenance": timezone_provenance,
    }


def _write_trust_report_artifact(report: Dict[str, Any]) -> str:
    parse_run_id = str(report.get("parse_run_id") or "").strip()
    if not parse_run_id:
        return ""
    try:
        TRUST_REPORT_DIR.mkdir(parents=True, exist_ok=True)
        artifact_path = TRUST_REPORT_DIR / f"{parse_run_id}.trust-report.json"
        report["artifact_path"] = str(artifact_path)
        artifact_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        return str(artifact_path)
    except Exception as exc:
        print(
            "[PARSER_TRUST_REPORT_WRITE_FAILED] "
            + json.dumps({"parse_run_id": parse_run_id, "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return ""


def build_parser_trust_report(
    *,
    path: str,
    clean_text: str,
    segments: List[Any],
    segment_map: Dict,
    candidates: List[Candidate],
    decisions: List[DecisionRow],
    template_id: str,
    template_family_id: str,
    learning_source: str,
    update_confidence: bool,
) -> Dict[str, Any]:
    decisions_by_field = {row.field: row for row in decisions}
    parse_run_id = _trust_report_parse_run_id(path, clean_text, template_id, template_family_id, decisions)
    fields: Dict[str, Any] = {}
    for report_field in _TRUST_REPORT_FIELDS:
        parser_field = _report_parser_field(report_field)
        candidate_types = _report_candidate_types(report_field)
        field_candidates = [
            candidate for candidate in candidates
            if getattr(candidate, "field_type", "") in candidate_types
        ]
        fields[report_field] = _build_field_trust_report(
            report_field,
            decisions_by_field.get(parser_field),
            field_candidates,
            candidates,
            segments,
            segment_map,
            clean_text,
            template_family_id,
            update_confidence,
        )

    summary = {
        "assigned_count": sum(1 for field in fields.values() if field["decision"] == "assigned"),
        "suggested_count": sum(1 for field in fields.values() if field["decision"] == "suggested"),
        "missing_count": sum(1 for field in fields.values() if field["decision"] == "missing"),
        "blocked_candidate_count": sum(
            1
            for field in fields.values()
            for candidate in field.get("competing_candidates", [])
            if candidate.get("block_reasons")
        ),
        "safety_failed_field_count": sum(1 for field in fields.values() if not field.get("safety", {}).get("passed")),
    }
    report = {
        "schema_version": TRUST_REPORT_SCHEMA_VERSION,
        "parse_run_id": parse_run_id,
        "source_file": path,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "template_id": template_id,
        "template_family_id": template_family_id,
        "learning_source": learning_source,
        "learning_confidence_updated": bool(update_confidence),
        "artifact_path": "",
        "fields": fields,
        "summary": summary,
    }
    artifact_path = _write_trust_report_artifact(report)
    print(
        "[PARSER_TRUST_REPORT] "
        + json.dumps({
            "parse_run_id": parse_run_id,
            "artifact_path": artifact_path,
            "field_count": len(fields),
            "safety_failed_field_count": summary["safety_failed_field_count"],
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return report


def build_parser_trust_report_safe(**kwargs: Any) -> Dict[str, Any]:
    try:
        return build_parser_trust_report(**kwargs)
    except Exception as exc:
        decisions = kwargs.get("decisions", []) or []
        clean_text = kwargs.get("clean_text", "") or ""
        path = kwargs.get("path", "") or ""
        template_id = kwargs.get("template_id", "") or ""
        template_family_id = kwargs.get("template_family_id", "") or ""
        parse_run_id = _trust_report_parse_run_id(path, clean_text, template_id, template_family_id, decisions)
        report = {
            "schema_version": TRUST_REPORT_SCHEMA_VERSION,
            "parse_run_id": parse_run_id,
            "source_file": path,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "template_id": template_id,
            "template_family_id": template_family_id,
            "learning_source": kwargs.get("learning_source", "unknown"),
            "learning_confidence_updated": bool(kwargs.get("update_confidence", False)),
            "artifact_path": "",
            "fields": {},
            "summary": {
                "assigned_count": 0,
                "suggested_count": 0,
                "missing_count": len(_TRUST_REPORT_FIELDS),
                "blocked_candidate_count": 0,
                "safety_failed_field_count": 0,
            },
            "error": str(exc),
        }
        artifact_path = _write_trust_report_artifact(report)
        print(
            "[PARSER_TRUST_REPORT_FAILED] "
            + json.dumps({"parse_run_id": parse_run_id, "artifact_path": artifact_path, "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return report


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


def _quantity_context(candidate, segments: List[Any]) -> str:
    seg_text = getattr(candidate, "segment_text", "") or ""
    parts = [
        getattr(candidate, "left_context", "") or "",
        seg_text,
        getattr(candidate, "right_context", "") or "",
    ]
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        window = segments[max(0, idx - 2): idx + 3]
        parts.extend(seg.text for seg in window)
    return " ".join(part for part in parts if part)


def _quantity_label_context(candidate) -> str:
    context = " ".join([
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ]).lower()
    if re.search(r"\b(?:qty|quantity)\b", context):
        return "explicit_quantity_label"
    if re.search(r"\bitems?\s+ordered\b|\border\s+(?:contains|has)\b|\bsale of\b|\byou sold\b", context):
        return "explicit_item_count_label"
    if re.search(r"(?:^|\s)[x×]\s*\d+\b", context):
        return "quantity_symbol"
    return _infer_label_key(candidate)


def _quantity_nearby_signals(candidate, segments: List[Any]) -> str:
    context = _quantity_context(candidate, segments).lower()
    signals: List[str] = []
    if re.search(r"\b(?:product|item|line item|listing)\b", context):
        signals.append("near_product")
    if re.search(r"\b(?:price|each|unit price|per unit)\b|[$]\s*\d", context):
        signals.append("near_price")
    if re.search(r"\b(?:sku|product id|item id|listing id)\b", context):
        signals.append("near_identifier")
    return "+".join(signals) if signals else "no_nearby_item_signal"


def _quantity_section_type(candidate, segments: List[Any]) -> str:
    context = _quantity_context(candidate, segments).lower()
    if _ORDER_HEADER_ITEM_COUNT_RE.search(context) or _ETSY_SALE_HEADER_QTY_RE.search(context):
        return "order_header"
    if re.search(r"\b(?:product|item|line item|listing|qty|quantity|each|unit price|price)\b", context) or re.search(r"(?:^|\s)[x×]\s*\d+\b", context):
        return "line_item"
    if re.search(r"\b(?:subtotal|total|tax|shipping|discount|payment|summary)\b", context):
        return "summary"
    if _QUANTITY_ADDRESS_CONTEXT_RE.search(context):
        return "address"
    return "body"


def _quantity_position_class(candidate, segments: List[Any]) -> str:
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is None:
        start = getattr(candidate, "start", None)
        if isinstance(start, int):
            if start < 250:
                return "early_header"
            if start < 1000:
                return "early_body"
        return "unknown_position"
    total = max(len(segments), 1)
    ratio = idx / total
    if ratio <= 0.2:
        return "early_header"
    if ratio <= 0.75:
        return "body"
    return "late_body"


def _quantity_type(candidate, segments: List[Any]) -> str:
    context = _quantity_context(candidate, segments)
    local_context = " ".join([
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ])
    if _ORDER_HEADER_ITEM_COUNT_RE.search(context) or _ETSY_SALE_HEADER_QTY_RE.search(context):
        return "order_header_item_count"
    if re.search(r"\b(?:qty|quantity)\b", context, re.IGNORECASE) or re.search(r"(?:^|\s)[x×]\s*\d+\b", context, re.IGNORECASE):
        return "line_item_quantity"
    if re.search(r"\bitems?\b", context, re.IGNORECASE):
        return "item_count"
    return "generic_number"


def quantity_safety_reasons(candidate, segments: List[Any], segment_map: Dict) -> List[str]:
    value = (getattr(candidate, "value", "") or "").strip().replace(",", "")
    context = _quantity_context(candidate, segments)
    segment = getattr(candidate, "segment_text", "") or ""
    local_context = " ".join([
        segment,
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "right_context", "") or "",
    ])
    qtype = _quantity_type(candidate, segments)
    section = _quantity_section_type(candidate, segments)
    role = classify_role("quantity", candidate)
    has_explicit_quantity_marker = bool(_QUANTITY_EXPLICIT_MARKER_RE.search(segment))
    reasons: List[str] = []

    if not re.fullmatch(r"\d+", value):
        reasons.append("not_plain_integer")
    else:
        qty = int(value)
        if qty < 1 or qty > 999:
            reasons.append("implausible_quantity_range")

    if qtype not in _QUANTITY_SAFE_ROLES:
        reasons.append(f"unsafe_quantity_type:{qtype}")
    if section not in {"line_item", "order_header"}:
        reasons.append(f"unsafe_section:{section}")
    if role not in {"quantity_label", "line_item_quantity", "item_count"} and qtype not in _QUANTITY_SAFE_ROLES:
        reasons.append(f"unsafe_role:{role}")
    if has_explicit_order_support(candidate):
        reasons.append("order_number_context")
    if _QUANTITY_SKU_CONTEXT_RE.search(context) and not re.search(r"\b(?:qty|quantity)\b", segment, re.IGNORECASE):
        reasons.append("sku_or_product_identifier_context")
    if has_address_or_postal_context(candidate) or _QUANTITY_ADDRESS_CONTEXT_RE.search(context):
        reasons.append("address_or_postal_context")
    if _ZIP_RE.fullmatch(value):
        reasons.append("zip_like_value")
    if _QUANTITY_PRICE_CONTEXT_RE.search(local_context) and not has_explicit_quantity_marker:
        reasons.append("price_or_summary_context")
    if _PRICE_DATE_CONTEXT_RE.search(context):
        reasons.append("date_context")
    if _QUANTITY_DIMENSION_CONTEXT_RE.search(local_context) and not has_explicit_quantity_marker:
        reasons.append("dimension_or_size_context")
    if re.fullmatch(r"\d{4}", value) and 1900 <= int(value) <= 2100:
        reasons.append("year_like_value")
    if _QUANTITY_PHONE_RE.fullmatch(value):
        reasons.append("phone_like_value")
    if _QUANTITY_MARKETING_RE.search(context):
        reasons.append("marketing_threshold_context")

    old_sig = build_quantity_signature(candidate, segment_map, " ".join(seg.text for seg in segments)) or build_extraction_signature(candidate, segment_map)
    if old_sig in _GENERIC_QUANTITY_SIGS or old_sig == "number_regex|none|body":
        reasons.append("generic_quantity_signature")

    return reasons


def is_safe_quantity_candidate(candidate, segments: List[Any], segment_map: Dict) -> bool:
    return not quantity_safety_reasons(candidate, segments, segment_map)


def build_quantity_confidence_signature(candidate, segment_map: Dict, segments: List[Any], clean_text: str = "") -> str:
    old_signature = build_quantity_signature(candidate, segment_map, clean_text) or build_extraction_signature(candidate, segment_map)
    if not is_safe_quantity_candidate(candidate, segments, segment_map):
        return old_signature

    extractor = candidate.extractor or "unknown"
    qtype = _quantity_type(candidate, segments)
    label = _quantity_label_context(candidate)
    section = _quantity_section_type(candidate, segments)
    nearby = _quantity_nearby_signals(candidate, segments)
    position = _quantity_position_class(candidate, segments)
    role = qtype if qtype in _QUANTITY_SAFE_ROLES else classify_role("quantity", candidate)
    return f"{extractor}|{qtype}|{label}|{role}|{nearby}|{section}|{position}"


def _quantity_confidence_signature_trace(candidate, segment_map: Dict, segments: List[Any], clean_text: str = "") -> Dict[str, Any]:
    old_signature = build_quantity_signature(candidate, segment_map, clean_text) or build_extraction_signature(candidate, segment_map)
    new_signature = build_quantity_confidence_signature(candidate, segment_map, segments, clean_text)
    safety_reasons = quantity_safety_reasons(candidate, segments, segment_map)
    qtype = _quantity_type(candidate, segments)
    structural_sig = structural_signature("quantity", candidate)
    upgraded = new_signature != old_signature
    return {
        "field": "quantity",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": classify_role("quantity", candidate),
        "quantity_type": qtype,
        "label_context": _quantity_label_context(candidate),
        "nearby_signals": _quantity_nearby_signals(candidate, segments),
        "section_type": _quantity_section_type(candidate, segments),
        "positional_trust": _quantity_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and qtype in _QUANTITY_SAFE_ROLES and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded,
        "quarantine_reason": "" if not safety_reasons else "failed_quantity_safety",
    }


def _order_date_context(candidate, segments: List[Any]) -> str:
    parts = [
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "right_context", "") or "",
    ]
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        parts.extend(seg.text for seg in segments[max(0, idx - 2): idx + 3])
    return " ".join(part for part in parts if part)


def _order_date_source_type(candidate) -> str:
    source = getattr(candidate, "source", "") or ""
    if source == "header" or getattr(candidate, "extractor", "") == "date_header":
        return "metadata_header"
    if source == "subject" or getattr(candidate, "segment_id", "") == "subject":
        return "subject"
    if source == "order_date_structural_trust_replay":
        return "structural_replay"
    return "body"


def _order_date_label_context(candidate, segments: List[Any]) -> str:
    context = _order_date_context(candidate, segments)
    if getattr(candidate, "extractor", "") == "date_header" or _order_date_source_type(candidate) == "metadata_header":
        return "metadata_date_header"
    match = _ORDER_DATE_EXPLICIT_RE.search(context)
    if match:
        return re.sub(r"[^a-z0-9]+", "_", match.group().strip().lower()).strip("_")
    match = _ORDER_DATE_SUMMARY_RE.search(context)
    if match:
        return re.sub(r"[^a-z0-9]+", "_", match.group().strip().lower()).strip("_")
    return _infer_label_key(candidate)


def _order_date_semantic_role(candidate, segments: List[Any]) -> str:
    context = _order_date_context(candidate, segments)
    segment = getattr(candidate, "segment_text", "") or ""
    source_type = _order_date_source_type(candidate)
    if source_type == "metadata_header":
        return "metadata_fallback_date"
    if _ORDER_DATE_SHIP_BY_RE.search(context):
        return "ship_by_date"
    if _ORDER_DATE_DELIVERY_RE.search(context):
        return "delivery_date"
    if _ORDER_DATE_PAYMENT_RE.search(context):
        return "payment_date"
    if _ORDER_DATE_TRACKING_RE.search(context):
        return "tracking_date"
    if _ORDER_DATE_INVOICE_RE.search(context):
        return "invoice_due_date"
    if _ORDER_DATE_FOOTER_RE.search(context):
        return "footer_date"
    if source_type == "subject" and (_ORDER_DATE_EXPLICIT_RE.search(context) or _ORDER_DATE_SUMMARY_RE.search(context)):
        return "subject_order_event_date"
    if _ORDER_DATE_EXPLICIT_RE.search(context):
        return "explicit_order_date"
    if _ORDER_DATE_SUMMARY_RE.search(segment):
        return "order_summary_date"
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        previous = " ".join(seg.text for seg in segments[max(0, idx - 2):idx])
        if _ORDER_DATE_NEARBY_SUMMARY_RE.search(previous):
            return "order_summary_date"
    return "generic_unlabeled_date"


def _order_date_section_type(candidate, segments: List[Any]) -> str:
    source_type = _order_date_source_type(candidate)
    if source_type == "metadata_header":
        return "metadata_header"
    if source_type == "subject":
        return "subject"
    context = _order_date_context(candidate, segments)
    segment = getattr(candidate, "segment_text", "") or ""
    if _ORDER_DATE_HEADER_RE.search(segment):
        return "email_header"
    if _ORDER_DATE_SHIP_BY_RE.search(context):
        return "ship_by"
    if _ORDER_DATE_DELIVERY_RE.search(context):
        return "delivery"
    if _ORDER_DATE_PAYMENT_RE.search(context):
        return "payment"
    if _ORDER_DATE_TRACKING_RE.search(context):
        return "tracking"
    if _ORDER_DATE_INVOICE_RE.search(context):
        return "invoice"
    if _ORDER_DATE_FOOTER_RE.search(context):
        return "footer"
    if _ORDER_DATE_EXPLICIT_RE.search(context) or _ORDER_DATE_SUMMARY_RE.search(context):
        return "order"
    return "body"


def _order_date_position_class(candidate, segments: List[Any]) -> str:
    source_type = _order_date_source_type(candidate)
    if source_type in {"subject", "metadata_header"}:
        return source_type
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is None:
        return "unknown_position"
    total = max(len(segments), 1)
    ratio = idx / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "body"
    return "late_body"


def _order_date_line_relation(candidate, segments: List[Any]) -> str:
    source_type = _order_date_source_type(candidate)
    if source_type == "subject":
        return "subject_line"
    if source_type == "metadata_header":
        return "metadata_header"
    segment = getattr(candidate, "segment_text", "") or ""
    if _ORDER_DATE_EXPLICIT_RE.search(segment) or _ORDER_DATE_SUMMARY_RE.search(segment):
        return "same_line"
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        previous = " ".join(seg.text for seg in segments[max(0, idx - 2):idx])
        if _ORDER_DATE_EXPLICIT_RE.search(previous) or _ORDER_DATE_NEARBY_SUMMARY_RE.search(previous):
            return "nearby_line"
    return "unknown_line_relation"


def _order_date_metadata_fallback_class(candidate, candidates: List[Any] | None, segments: List[Any], segment_map: Dict) -> str:
    if _order_date_source_type(candidate) != "metadata_header":
        return "not_metadata"
    if _has_safer_order_date_candidate(candidate, candidates or [], segments, segment_map):
        return "header_suppressed_by_body_or_subject"
    return "header_only_no_safe_competitor"


def _order_date_competing_context(candidate, candidates: List[Any] | None, segments: List[Any]) -> str:
    roles = []
    for other in candidates or []:
        if other is candidate:
            continue
        role = _order_date_semantic_role(other, segments)
        if role in _ORDER_DATE_UNSAFE_ROLES:
            roles.append(role)
        elif role in {"explicit_order_date", "subject_order_event_date", "order_summary_date"}:
            roles.append("safe_body_subject_order_date")
    return "none" if not roles else "+".join(sorted(set(roles)))


def _has_safer_order_date_candidate(candidate, candidates: List[Any], segments: List[Any], segment_map: Dict) -> bool:
    for other in candidates:
        if other is candidate:
            continue
        if _order_date_source_type(other) == "metadata_header":
            continue
        role = _order_date_semantic_role(other, segments)
        if role in {"explicit_order_date", "subject_order_event_date", "order_summary_date"}:
            return True
    return False


def order_date_safety_reasons(
    candidate,
    segments: List[Any],
    segment_map: Dict,
    candidates: List[Any] | None = None,
) -> List[str]:
    value = (getattr(candidate, "value", "") or "").strip()
    role = _order_date_semantic_role(candidate, segments)
    section = _order_date_section_type(candidate, segments)
    line_relation = _order_date_line_relation(candidate, segments)
    source_type = _order_date_source_type(candidate)
    reasons: List[str] = []

    if not value:
        reasons.append("empty_date")
    if source_type not in {"body", "subject", "metadata_header"}:
        reasons.append(f"unsafe_source:{source_type}")
    if role not in _ORDER_DATE_SAFE_ROLES:
        reasons.append(f"role_not_order_date:{role}")
    if section in {"ship_by", "delivery", "payment", "tracking", "footer", "invoice", "email_header"}:
        reasons.append(f"unsafe_section:{section}")
    if line_relation == "unknown_line_relation" and role != "metadata_fallback_date":
        reasons.append("generic_date_span_without_stable_order_context")
    if role == "metadata_fallback_date":
        fallback_class = _order_date_metadata_fallback_class(candidate, candidates, segments, segment_map)
        if fallback_class != "header_only_no_safe_competitor":
            reasons.append(f"metadata_fallback_blocked:{fallback_class}")

    return reasons


def _order_date_stronger_unsafe_competitor_reason(candidate, candidates: List[Any] | None, segments: List[Any]) -> str:
    for other in candidates or []:
        if other is candidate:
            continue
        other_role = _order_date_semantic_role(other, segments)
        if other_role in _ORDER_DATE_UNSAFE_ROLES and float(getattr(other, "score", 0.0) or 0.0) >= float(getattr(candidate, "score", 0.0) or 0.0):
            return f"stronger_unsafe_date_competitor:{other_role}"
    return ""


def is_safe_order_date_candidate(
    candidate,
    segments: List[Any],
    segment_map: Dict,
    candidates: List[Any] | None = None,
) -> bool:
    return not order_date_safety_reasons(candidate, segments, segment_map, candidates)


def build_order_date_confidence_signature(
    candidate,
    segment_map: Dict,
    segments: List[Any],
    candidates: List[Any] | None = None,
) -> str:
    old_signature = build_extraction_signature(candidate, segment_map)
    if not is_safe_order_date_candidate(candidate, segments, segment_map, candidates):
        return old_signature

    extractor = candidate.extractor or "unknown"
    source_type = _order_date_source_type(candidate)
    role = _order_date_semantic_role(candidate, segments)
    label = _order_date_label_context(candidate, segments)
    section = _order_date_section_type(candidate, segments)
    line_relation = _order_date_line_relation(candidate, segments)
    metadata_class = _order_date_metadata_fallback_class(candidate, candidates, segments, segment_map)
    position = _order_date_position_class(candidate, segments)
    competing = _order_date_competing_context(candidate, candidates, segments)
    return f"{extractor}|{source_type}|{role}|{label}|{section}|{line_relation}|{metadata_class}|{position}|{competing}"


def _order_date_confidence_signature_trace(candidate, segment_map: Dict, segments: List[Any], candidates: List[Any]) -> Dict[str, Any]:
    old_signature = build_extraction_signature(candidate, segment_map)
    new_signature = build_order_date_confidence_signature(candidate, segment_map, segments, candidates)
    safety_reasons = order_date_safety_reasons(candidate, segments, segment_map, candidates)
    role = _order_date_semantic_role(candidate, segments)
    structural_sig = structural_signature("order_date", candidate)
    upgraded = new_signature != old_signature
    return {
        "field": "order_date",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": role,
        "source_type": _order_date_source_type(candidate),
        "label_context": _order_date_label_context(candidate, segments),
        "section_type": _order_date_section_type(candidate, segments),
        "line_relation": _order_date_line_relation(candidate, segments),
        "metadata_fallback_class": _order_date_metadata_fallback_class(candidate, candidates, segments, segment_map),
        "position_class": _order_date_position_class(candidate, segments),
        "competing_date_context": _order_date_competing_context(candidate, candidates, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and role in _ORDER_DATE_SAFE_ROLES and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded,
        "quarantine_reason": "" if not safety_reasons else "failed_order_date_safety",
    }


def _apply_order_date_safety(candidates: List[Any], segments: List[Any], segment_map: Dict) -> List[Any]:
    for candidate in candidates:
        trace = _order_date_confidence_signature_trace(candidate, segment_map, segments, candidates)
        reasons = trace["safety_reasons"]
        provenance = getattr(candidate, "provenance_extra", {}) or {}
        provenance.update({
            "why_assigned": "safe_order_date_candidate" if not reasons else "",
            "why_not_assigned": ",".join(reasons) if reasons else "",
            "source_priority_used": trace["source_type"],
            "metadata_fallback_used": trace["metadata_fallback_class"] == "header_only_no_safe_competitor",
            "competing_date_block_reason": ",".join(
                reason for reason in reasons if "competitor" in reason or "metadata_fallback_blocked" in reason
            ),
            "maturity_state": "eligible" if trace["structural_trust_eligible"] else "blocked",
        })
        candidate.provenance_extra = provenance
        if reasons:
            if candidate.score > -999:
                candidate.score = -999
            candidate.penalties.append("order_date_safety_gate(-inf)")
            print(
                "[ORDER_DATE_SAFETY_BLOCKED] "
                + json.dumps({
                    "field": "order_date",
                    "value": getattr(candidate, "value", ""),
                    "candidate_id": getattr(candidate, "id", ""),
                    "role": trace["role"],
                    "source_priority_used": trace["source_type"],
                    "metadata_fallback_used": provenance["metadata_fallback_used"],
                    "competing_date_block_reason": provenance["competing_date_block_reason"],
                    "why_not_assigned": provenance["why_not_assigned"],
                    "maturity_state": provenance["maturity_state"],
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
    return candidates


def _order_date_source_priority(candidate, segments: List[Any]) -> str:
    role = _order_date_semantic_role(candidate, segments)
    source_type = _order_date_source_type(candidate)
    if role == "explicit_order_date" and source_type == "body":
        return "explicit_body_order_date"
    if role == "subject_order_event_date":
        return "subject_order_event_date"
    if role == "order_summary_date":
        return "order_summary_order_context_date"
    if role == "metadata_fallback_date":
        return "metadata_header_fallback"
    return f"blocked_{role}"


def _order_date_priority_rank(candidate, segments: List[Any]) -> float:
    priority = _order_date_source_priority(candidate, segments)
    return {
        "explicit_body_order_date": 8.0,
        "subject_order_event_date": 6.0,
        "order_summary_order_context_date": 4.0,
        "metadata_header_fallback": 1.0,
    }.get(priority, -10.0)


def _order_date_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    safety_reasons = order_date_safety_reasons(candidate, segments, segment_map, candidates)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)
    role = _order_date_semantic_role(candidate, segments)
    if role not in _ORDER_DATE_SAFE_ROLES:
        return f"role_not_order_date:{role}"
    competitor_reason = _order_date_stronger_unsafe_competitor_reason(candidate, candidates, segments)
    if competitor_reason:
        return competitor_reason
    if confidence_signature == build_extraction_signature(candidate, segment_map):
        return "legacy_or_generic_order_date_signature"

    structural_sig = structural_signature("order_date", candidate)
    trust_records = load_structural_trust("order_date", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != role:
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"
    return ""


def _promote_order_date_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("order_date", candidate)
    role = _order_date_semantic_role(candidate, segments)
    block_reason = _order_date_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["order_date_role"] = role
    row.provenance["source_priority_used"] = _order_date_source_priority(candidate, segments)
    row.provenance["metadata_fallback_used"] = role == "metadata_fallback_date"
    row.provenance["competing_date_block_reason"] = ""

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["why_not_assigned"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        row.provenance["competing_date_block_reason"] = block_reason if "competitor" in block_reason else ""
        print(
            "[ORDER_DATE_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "order_date",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "source_priority_used": row.provenance["source_priority_used"],
                "metadata_fallback_used": row.provenance["metadata_fallback_used"],
                "competing_date_block_reason": row.provenance["competing_date_block_reason"],
                "why_not_assigned": block_reason,
                "maturity_state": "blocked",
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "order_date",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": role,
            "source": "safe_order_date_maturation",
            "label_context": _order_date_label_context(candidate, segments),
            "section_type": _order_date_section_type(candidate, segments),
            "line_relation": _order_date_line_relation(candidate, segments),
            "metadata_fallback_class": _order_date_metadata_fallback_class(candidate, candidates, segments, segment_map),
            "source_priority_used": _order_date_source_priority(candidate, segments),
            **{
                key: (getattr(candidate, "provenance_extra", {}) or {}).get(key, "")
                for key in (
                    "raw_header_date",
                    "parsed_header_datetime",
                    "source_timezone",
                    "business_timezone_used",
                    "final_calendar_date",
                    "timezone_adjustment_reason",
                )
                if (getattr(candidate, "provenance_extra", {}) or {}).get(key, "")
            },
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "order_date_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_order_date_structural_maturity"
    row.provenance["why_assigned"] = "safe_order_date_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[ORDER_DATE_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "order_date",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "source_priority_used": row.provenance["source_priority_used"],
            "metadata_fallback_used": row.provenance["metadata_fallback_used"],
            "why_assigned": row.provenance["why_assigned"],
            "maturity_state": "promoted",
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_order_date_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "order_date")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("order_date", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") in _ORDER_DATE_SAFE_ROLES
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []
    for candidate in candidates:
        confidence_sig = build_order_date_confidence_signature(candidate, segment_map, segments, candidates)
        structural_sig = structural_signature("order_date", candidate)
        reasons = order_date_safety_reasons(candidate, segments, segment_map, candidates)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        role = _order_date_semantic_role(candidate, segments)
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
                or (
                    record.get("role") == role
                    and record.get("source_priority_used", "") == _order_date_source_priority(candidate, segments)
                )
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_order_date_structural_trust")
        competitor_reason = _order_date_stronger_unsafe_competitor_reason(candidate, candidates, segments)
        if competitor_reason:
            reasons.append(competitor_reason)

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "role": role,
                "source_priority_used": _order_date_source_priority(candidate, segments),
                "metadata_fallback_used": role == "metadata_fallback_date",
                "block_reason": reasons,
            })
            continue

        rank = (
            float(getattr(candidate, "score", 0.0))
            + float(trust.get("trust_score") or 0.0)
            + _order_date_priority_rank(candidate, segments)
        )
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[ORDER_DATE_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "order_date",
                "template_id": template_id,
                "metadata_support": "Date header only; Received headers excluded",
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    role = _order_date_semantic_role(candidate, segments)
    source_priority = _order_date_source_priority(candidate, segments)
    replay = Candidate(
        id="structural_replay_order_date_0001",
        field_type="date",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "order_date_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            f"source_priority_used={source_priority}",
            "why_assigned=trusted_order_date_structural_replay_current_value",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="order_date_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "order_date_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_order_date_structural_replay_current_value",
        "why_not_assigned": "",
        "source_priority_used": source_priority,
        "metadata_fallback_used": role == "metadata_fallback_date",
        "competing_date_block_reason": "",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "order_date_role": role,
        "maturity_state": "replayed",
    }
    print(
        "[ORDER_DATE_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "order_date",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "decision_source": "order_date_structural_trust_replay",
            "source_priority_used": source_priority,
            "metadata_fallback_used": role == "metadata_fallback_date",
            "why_assigned": replay.provenance_extra["why_assigned"],
            "maturity_state": "replayed",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _ship_by_context(candidate, segments: List[Any]) -> str:
    parts = [
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "right_context", "") or "",
    ]
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        parts.extend(seg.text for seg in segments[max(0, idx - 2): idx + 3])
    return " ".join(part for part in parts if part)


def _ship_by_label_context(candidate, segments: List[Any]) -> str:
    context = _ship_by_context(candidate, segments)
    if _SHIP_BY_DISPATCH_RE.search(context):
        return "dispatch_by"
    if _SHIP_BY_ESTIMATED_SHIP_RE.search(context):
        return "estimated_ship_date"
    if re.search(r"\bships\s*by\b", context, re.IGNORECASE):
        return "ships_by"
    if re.search(r"\bship\s*by\b", context, re.IGNORECASE):
        return "ship_by"
    return _infer_label_key(candidate)


def _ship_by_semantic_role(candidate, segments: List[Any]) -> str:
    context = _ship_by_context(candidate, segments)
    if _SHIP_BY_DELIVERY_RE.search(context):
        return "delivery_date"
    if _SHIP_BY_ORDER_DATE_RE.search(context):
        return "order_date"
    if _SHIP_BY_PAYMENT_RE.search(context):
        return "payment_date"
    if _SHIP_BY_TRACKING_RE.search(context):
        return "tracking_date"
    if _SHIP_BY_FOOTER_RE.search(context):
        return "footer_date"
    if _SHIP_BY_LABEL_RE.search(context):
        return "ship_by_date"
    return classify_role("ship_by", candidate)


def _ship_by_section_type(candidate, segments: List[Any]) -> str:
    if getattr(candidate, "source", "") == "subject" or getattr(candidate, "segment_id", "") == "subject":
        return "subject"
    context = _ship_by_context(candidate, segments)
    segment = getattr(candidate, "segment_text", "") or ""
    if _SHIP_BY_HEADER_RE.search(segment):
        return "email_header"
    if _SHIP_BY_DELIVERY_RE.search(context):
        return "delivery"
    if _SHIP_BY_PAYMENT_RE.search(context):
        return "payment"
    if _SHIP_BY_TRACKING_RE.search(context):
        return "tracking"
    if _SHIP_BY_FOOTER_RE.search(context):
        return "footer"
    if _SHIP_BY_ORDER_DATE_RE.search(context):
        return "order"
    if _SHIP_BY_LABEL_RE.search(context):
        return "order_ops"
    return "body"


def _ship_by_position_class(candidate, segments: List[Any]) -> str:
    if getattr(candidate, "source", "") == "subject" or getattr(candidate, "segment_id", "") == "subject":
        return "subject"
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is None:
        return "unknown_position"
    total = max(len(segments), 1)
    ratio = idx / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "body"
    return "late_body"


def _ship_by_line_confidence(candidate, segments: List[Any]) -> str:
    extractor = getattr(candidate, "extractor", "") or ""
    segment = getattr(candidate, "segment_text", "") or ""
    if getattr(candidate, "source", "") == "subject":
        return "subject_line"
    if extractor == "ship_by_body_regex" and _SHIP_BY_LABEL_RE.search(segment):
        return "same_line"
    if extractor == "ship_by_body_nearby_regex":
        return "nearby_line"
    return "unknown_line_relation"


def ship_by_safety_reasons(candidate, segments: List[Any], segment_map: Dict) -> List[str]:
    value = (getattr(candidate, "value", "") or "").strip()
    context = _ship_by_context(candidate, segments)
    segment = getattr(candidate, "segment_text", "") or ""
    role = _ship_by_semantic_role(candidate, segments)
    section = _ship_by_section_type(candidate, segments)
    line_relation = _ship_by_line_confidence(candidate, segments)
    reasons: List[str] = []

    if not _SHIP_BY_MONTH_DAY_RE.fullmatch(value):
        reasons.append("not_month_day_date")
    if role != "ship_by_date":
        reasons.append(f"role_not_ship_by_date:{role}")
    if not _SHIP_BY_LABEL_RE.search(context):
        reasons.append("missing_ship_or_dispatch_context")
    if _SHIP_BY_DELIVERY_RE.search(context):
        reasons.append("delivery_date_context")
    if _SHIP_BY_ORDER_DATE_RE.search(context):
        reasons.append("order_date_context")
    if _SHIP_BY_PAYMENT_RE.search(context):
        reasons.append("payment_date_context")
    if _SHIP_BY_TRACKING_RE.search(context):
        reasons.append("tracking_date_context")
    if _SHIP_BY_FOOTER_RE.search(context):
        reasons.append("footer_or_browser_context")
    if section in {"email_header", "delivery", "payment", "tracking", "footer", "order"}:
        reasons.append(f"unsafe_section:{section}")
    if line_relation == "nearby_line":
        idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
        if idx is None:
            reasons.append("nearby_line_without_segment")
        else:
            previous = [seg.text for seg in segments[max(0, idx - 2):idx]]
            if not previous or not any(_SHIP_BY_LABEL_RE.search(text) for text in previous):
                reasons.append("unstable_nearby_line_without_label")
            if any(
                _SHIP_BY_DELIVERY_RE.search(text)
                or _SHIP_BY_PAYMENT_RE.search(text)
                or _SHIP_BY_TRACKING_RE.search(text)
                or _SHIP_BY_FOOTER_RE.search(text)
                or _SHIP_BY_ORDER_DATE_RE.search(text)
                for text in previous
            ):
                reasons.append("unstable_nearby_line_contamination")
    if line_relation == "unknown_line_relation":
        reasons.append("generic_date_span_without_stable_ship_context")
    if getattr(candidate, "source", "") not in {"subject", "body"}:
        reasons.append("unsafe_source")
    if _SHIP_BY_HEADER_RE.search(segment):
        reasons.append("email_header_date_context")

    return reasons


def is_safe_ship_by_candidate(candidate, segments: List[Any], segment_map: Dict) -> bool:
    return not ship_by_safety_reasons(candidate, segments, segment_map)


def build_ship_by_confidence_signature(candidate, segment_map: Dict, segments: List[Any]) -> str:
    old_signature = build_extraction_signature(candidate, segment_map)
    if not is_safe_ship_by_candidate(candidate, segments, segment_map):
        return old_signature

    extractor = candidate.extractor or "unknown"
    source = getattr(candidate, "source", "") or "unknown_source"
    label = _ship_by_label_context(candidate, segments)
    role = _ship_by_semantic_role(candidate, segments)
    section = _ship_by_section_type(candidate, segments)
    position = _ship_by_position_class(candidate, segments)
    line_relation = _ship_by_line_confidence(candidate, segments)
    return f"{extractor}|{source}|{label}|{role}|{section}|{position}|{line_relation}"


def _ship_by_confidence_signature_trace(candidate, segment_map: Dict, segments: List[Any]) -> Dict[str, Any]:
    old_signature = build_extraction_signature(candidate, segment_map)
    new_signature = build_ship_by_confidence_signature(candidate, segment_map, segments)
    safety_reasons = ship_by_safety_reasons(candidate, segments, segment_map)
    role = _ship_by_semantic_role(candidate, segments)
    structural_sig = structural_signature("ship_by", candidate)
    upgraded = new_signature != old_signature
    return {
        "field": "ship_by",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": role,
        "label_context": _ship_by_label_context(candidate, segments),
        "source": getattr(candidate, "source", ""),
        "section_type": _ship_by_section_type(candidate, segments),
        "line_relation": _ship_by_line_confidence(candidate, segments),
        "positional_trust": _ship_by_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and role == "ship_by_date" and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded,
        "quarantine_reason": "" if not safety_reasons else "failed_ship_by_safety",
    }


def _email_parts(value: str) -> tuple[str, str]:
    if "@" not in value:
        return value.casefold(), ""
    local, domain = value.rsplit("@", 1)
    return local.casefold(), domain.casefold()


def _buyer_email_context(candidate, segments: List[Any]) -> str:
    parts = [
        getattr(candidate, "left_context", "") or "",
        getattr(candidate, "segment_text", "") or "",
        getattr(candidate, "right_context", "") or "",
    ]
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is not None:
        parts.extend(seg.text for seg in segments[max(0, idx - 3): idx + 4])
    return " ".join(part for part in parts if part)


def _buyer_email_nearby_section(candidate, segments: List[Any]) -> str:
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is None:
        return ""
    for seg in reversed(segments[max(0, idx - 8):idx + 1]):
        text = seg.text or ""
        if _EMAIL_BILLING_CONTEXT_RE.search(text):
            return "billing"
        if _EMAIL_SHIPPING_CONTEXT_RE.search(text):
            return "shipping"
        if (
            _EMAIL_CUSTOMER_CONTEXT_RE.search(text)
            or _EMAIL_CONTACT_CONTEXT_RE.search(text)
            or _EMAIL_GUEST_CONTACT_RE.search(text)
        ):
            return "customer"
    return ""


def _buyer_email_label_context(candidate, segments: List[Any]) -> str:
    segment = getattr(candidate, "segment_text", "") or ""
    context = _buyer_email_context(candidate, segments)
    nearby_section = _buyer_email_nearby_section(candidate, segments)
    if _EMAIL_GUEST_CONTACT_RE.search(segment) or _EMAIL_GUEST_CONTACT_RE.search(context):
        return "customer_contact_email"
    if _EMAIL_CUSTOMER_CONTEXT_RE.search(segment) and re.search(r"\bemail\b", segment, re.IGNORECASE):
        return "customer_email"
    if re.search(r"\bbuyer\b", segment, re.IGNORECASE) and re.search(r"\bemail\b", segment, re.IGNORECASE):
        return "buyer_email"
    if _EMAIL_CONTACT_CONTEXT_RE.search(segment):
        return "customer_contact_email"
    if _EMAIL_BILLING_CONTEXT_RE.search(segment) and re.search(r"\bemail\b", segment, re.IGNORECASE):
        return "billing_email"
    if _EMAIL_SHIPPING_CONTEXT_RE.search(segment) and re.search(r"\bemail\b", segment, re.IGNORECASE):
        return "shipping_contact_email"
    if nearby_section == "billing":
        return "billing_email"
    if nearby_section == "shipping":
        return "shipping_contact_email"
    if nearby_section == "customer":
        return "customer_contact_email"
    if re.search(r"\bemail\b", segment, re.IGNORECASE):
        return "email_label"
    if _EMAIL_CUSTOMER_CONTEXT_RE.search(context):
        return "customer_context"
    return _infer_label_key(candidate)


def _buyer_email_role(candidate, segments: List[Any]) -> str:
    value = getattr(candidate, "value", "") or ""
    local, domain = _email_parts(value)
    segment = getattr(candidate, "segment_text", "") or ""
    context = _buyer_email_context(candidate, segments)
    label = _buyer_email_label_context(candidate, segments)
    if _EMAIL_SYSTEM_LOCAL_RE.search(local) or _EMAIL_PLATFORM_CONTEXT_RE.search(context):
        return "system_email"
    if _EMAIL_SELLER_CONTEXT_RE.search(segment) or re.search(r"\b(?:seller|store|shop|merchant|vendor)\b", domain, re.IGNORECASE):
        return "seller_email"
    if label in {"customer_email", "buyer_email", "customer_contact_email"}:
        return "buyer_email"
    if label == "shipping_contact_email":
        return "shipping_contact_email"
    if label == "billing_email":
        return "billing_email"
    if _EMAIL_SUPPORT_LOCAL_RE.search(local) or _EMAIL_FOOTER_CONTEXT_RE.search(segment):
        return "support_email"
    return "generic_email"


def _buyer_email_section_type(candidate, segments: List[Any]) -> str:
    segment = getattr(candidate, "segment_text", "") or ""
    context = _buyer_email_context(candidate, segments)
    label = _buyer_email_label_context(candidate, segments)
    if _EMAIL_HEADER_CONTEXT_RE.search(segment):
        return "email_header"
    if _EMAIL_SELLER_CONTEXT_RE.search(segment):
        return "seller"
    if _EMAIL_PLATFORM_CONTEXT_RE.search(context):
        return "system"
    if label in {"customer_email", "buyer_email", "customer_contact_email"}:
        return "customer"
    if label == "billing_email" or _EMAIL_BILLING_CONTEXT_RE.search(segment):
        return "billing"
    if label == "shipping_contact_email" or _EMAIL_SHIPPING_CONTEXT_RE.search(segment):
        return "shipping"
    if _EMAIL_CUSTOMER_CONTEXT_RE.search(context):
        return "customer"
    if _EMAIL_FOOTER_CONTEXT_RE.search(context):
        return "footer"
    return "body"


def _buyer_email_domain_class(candidate) -> str:
    local, domain = _email_parts(getattr(candidate, "value", "") or "")
    if not domain:
        return "invalid_domain"
    if _EMAIL_SYSTEM_LOCAL_RE.search(local):
        return "system_domain"
    if re.search(r"\b(?:marketplace|notification|notify|mailer|system|noreply|no-reply)\b", domain, re.IGNORECASE):
        return "platform_like_domain"
    if re.search(r"\b(?:shop|store|seller|vendor|merchant)\b", domain, re.IGNORECASE):
        return "seller_like_domain"
    if re.search(r"\b(?:gmail|yahoo|outlook|hotmail|icloud|aol|proton|me)\b", domain, re.IGNORECASE):
        return "personal_domain"
    return "business_or_custom_domain"


def _buyer_email_local_part_class(candidate) -> str:
    local, _domain = _email_parts(getattr(candidate, "value", "") or "")
    if _EMAIL_SYSTEM_LOCAL_RE.search(local):
        return "system_local"
    if _EMAIL_SUPPORT_LOCAL_RE.search(local):
        return "support_local"
    if re.search(r"[._-]", local) or re.search(r"[a-z]+\d*$", local, re.IGNORECASE):
        return "person_like_local"
    return "generic_local"


def _buyer_email_source_priority(candidate, candidates: List[Any], segments: List[Any]) -> str:
    role = _buyer_email_role(candidate, segments)
    if role == "buyer_email":
        return "primary_customer"
    if role == "shipping_contact_email":
        return "shipping_contact"
    if role == "billing_email":
        safer = [
            other for other in candidates
            if other.id != candidate.id
            and _buyer_email_role(other, segments) in {"buyer_email", "shipping_contact_email"}
            and _buyer_email_section_type(other, segments) not in {"email_header", "footer", "seller", "system"}
            and _buyer_email_domain_class(other) not in {"system_domain", "platform_like_domain", "seller_like_domain"}
            and _buyer_email_local_part_class(other) not in {"system_local", "support_local"}
        ]
        return "billing_fallback" if not safer else "billing_suppressed"
    return "blocked"


def _buyer_email_position_class(candidate, segments: List[Any]) -> str:
    idx = next((i for i, seg in enumerate(segments) if seg.id == getattr(candidate, "segment_id", "")), None)
    if idx is None:
        return "unknown_position"
    total = max(len(segments), 1)
    ratio = idx / total
    if ratio <= 0.25:
        return "early_body"
    if ratio <= 0.75:
        return "body"
    return "late_body"


def buyer_email_safety_reasons(
    candidate,
    candidates: List[Any],
    segments: List[Any],
    allow_billing_fallback: bool = False,
) -> List[str]:
    value = getattr(candidate, "value", "") or ""
    role = _buyer_email_role(candidate, segments)
    section = _buyer_email_section_type(candidate, segments)
    domain_class = _buyer_email_domain_class(candidate)
    local_class = _buyer_email_local_part_class(candidate)
    label = _buyer_email_label_context(candidate, segments)
    priority = _buyer_email_source_priority(candidate, candidates, segments) if candidates else "blocked"
    reasons: List[str] = []

    if "@" not in value:
        reasons.append("invalid_email")
    if role in {"system_email", "support_email", "seller_email", "generic_email"}:
        reasons.append(f"unsafe_role:{role}")
    if section in {"email_header", "footer", "seller", "system"}:
        reasons.append(f"unsafe_section:{section}")
    if domain_class in {"system_domain", "platform_like_domain", "seller_like_domain"}:
        reasons.append(f"unsafe_domain:{domain_class}")
    if local_class in {"system_local", "support_local"}:
        reasons.append(f"unsafe_local_part:{local_class}")
    if label in {"none", "email_label"} and role not in {"buyer_email", "shipping_contact_email", "billing_email"}:
        reasons.append("generic_unlabeled_body_email")
    if role == "billing_email" and priority != "billing_fallback" and not allow_billing_fallback:
        reasons.append("billing_email_not_fallback")
    if role == "shipping_contact_email" and priority == "blocked":
        reasons.append("shipping_contact_not_safe")
    if priority in {"billing_suppressed", "blocked"} and role not in {"system_email", "support_email", "seller_email", "generic_email"}:
        reasons.append(f"source_priority_blocked:{priority}")

    return reasons


def is_safe_buyer_email_candidate(candidate, candidates: List[Any], segments: List[Any]) -> bool:
    return not buyer_email_safety_reasons(candidate, candidates, segments)


def build_buyer_email_confidence_signature(candidate, segment_map: Dict, segments: List[Any], candidates: List[Any] | None = None) -> str:
    peers = candidates or [candidate]
    old_signature = build_extraction_signature(candidate, segment_map)
    if not is_safe_buyer_email_candidate(candidate, peers, segments):
        return old_signature
    extractor = candidate.extractor or "unknown"
    role = _buyer_email_role(candidate, segments)
    label = _buyer_email_label_context(candidate, segments)
    section = _buyer_email_section_type(candidate, segments)
    domain = _buyer_email_domain_class(candidate)
    local = _buyer_email_local_part_class(candidate)
    priority = _buyer_email_source_priority(candidate, peers, segments)
    position = _buyer_email_position_class(candidate, segments)
    return f"{extractor}|{role}|{label}|{section}|{domain}|{local}|{priority}|{position}"


def _buyer_email_confidence_signature_trace(candidate, candidates: List[Any], segment_map: Dict, segments: List[Any]) -> Dict[str, Any]:
    old_signature = build_extraction_signature(candidate, segment_map)
    new_signature = build_buyer_email_confidence_signature(candidate, segment_map, segments, candidates)
    safety_reasons = buyer_email_safety_reasons(candidate, candidates, segments)
    role = _buyer_email_role(candidate, segments)
    structural_sig = structural_signature("buyer_email", candidate)
    upgraded = new_signature != old_signature
    return {
        "field": "buyer_email",
        "value": getattr(candidate, "value", ""),
        "candidate_id": getattr(candidate, "id", ""),
        "old_signature": old_signature,
        "new_signature": new_signature,
        "structural_signature": structural_sig,
        "role": role,
        "label_context": _buyer_email_label_context(candidate, segments),
        "section_type": _buyer_email_section_type(candidate, segments),
        "domain_class": _buyer_email_domain_class(candidate),
        "local_part_class": _buyer_email_local_part_class(candidate),
        "source_priority": _buyer_email_source_priority(candidate, candidates, segments),
        "positional_trust": _buyer_email_position_class(candidate, segments),
        "safe": not safety_reasons,
        "safety_reasons": safety_reasons,
        "structural_trust_eligible": upgraded and role in {"buyer_email", "shipping_contact_email", "billing_email"} and not safety_reasons,
        "confidence_promotion_eligible_signature": upgraded,
        "quarantine_reason": "" if not safety_reasons else "failed_buyer_email_safety",
    }


def _apply_buyer_email_safety(candidates: List[Any], segments: List[Any]) -> List[Any]:
    for candidate in candidates:
        reasons = buyer_email_safety_reasons(candidate, candidates, segments)
        if not reasons:
            continue
        hard = any(
            reason.startswith("unsafe_role:")
            or reason.startswith("unsafe_section:")
            or reason.startswith("unsafe_domain:")
            or reason.startswith("unsafe_local_part:")
            or reason in {"generic_unlabeled_body_email", "billing_email_not_fallback"}
            or reason.startswith("source_priority_blocked:")
            for reason in reasons
        )
        if hard:
            candidate.score = -999
            candidate.penalties.append("buyer_email_safety_gate(-inf)")
        else:
            candidate.score -= 25
            candidate.penalties.append("buyer_email_safety_penalty(-25)")
        print(
            "[BUYER_EMAIL_SAFETY_BLOCKED] "
            + json.dumps({
                "field": "buyer_email",
                "candidate_id": candidate.id,
                "value": candidate.value,
                "reasons": reasons,
                "hard": hard,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
    return candidates


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

    if field == "order_number":
        active_records = [
            r for r in active_records
            if _order_number_record_is_safe(r.get("value", ""), r)
        ]
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

        if field == "order_number":
            if sig in GENERIC_NUMBER_SIGNATURES and not is_safe_order_number_candidate(candidate, sig):
                continue
            if not is_safe_order_number_candidate(candidate, sig):
                continue

        parts = sig.split("|")
        if sig in learned_sigs:
            candidate.score += 10.0
            candidate.signals.append("sig_exact_match(+10)")
        elif len(parts) >= 3 and f"{parts[0]}|{parts[2]}" in learned_ext_anchor:
            candidate.score += 6.0
            candidate.signals.append("sig_partial_match(+6)")

    return candidates


def _apply_structural_rules(
    candidates: List,
    field: str,
    template_id: str,
) -> List:
    """Apply durable positive/negative correction rules at candidate level."""
    negative_rules = load_structural_rules(field=field, polarity="negative")
    positive_rules = load_structural_rules(field=field, polarity="positive")
    if not negative_rules and not positive_rules:
        return candidates

    for candidate in candidates:
        role = classify_role(field, candidate)
        sig = structural_signature(field, candidate)

        for rule in negative_rules:
            if not rule_matches_candidate(rule, candidate):
                continue
            candidate.score -= 80.0
            candidate.penalties.append(f"structural_negative_rule:{rule.get('role', '')}(-80)")
            print(
                "[STRUCTURAL_RULE_REPLAY] "
                + json.dumps({
                    "field": field,
                    "polarity": "negative",
                    "candidate_value": candidate.value,
                    "candidate_role": role,
                    "candidate_signature": sig,
                    "rule_role": rule.get("role", ""),
                    "rule_signature": rule.get("structural_signature", ""),
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
            break

        for rule in positive_rules:
            if not rule_matches_candidate(rule, candidate):
                continue
            if field == "order_number" and not is_safe_order_number_candidate(candidate, sig):
                print(
                    "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
                    + json.dumps({
                        "field": field,
                        "candidate_value": candidate.value,
                        "candidate_role": role,
                        "candidate_signature": sig,
                    }, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                continue
            candidate.score += 8.0
            candidate.signals.append(f"structural_positive_rule:{rule.get('role', '')}(+8)")
            print(
                "[STRUCTURAL_RULE_REPLAY] "
                + json.dumps({
                    "field": field,
                    "polarity": "positive",
                    "candidate_value": candidate.value,
                    "candidate_role": role,
                    "candidate_signature": sig,
                    "rule_role": rule.get("role", ""),
                    "rule_signature": rule.get("structural_signature", ""),
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
            break

    return candidates


def _apply_structural_trust(
    candidates: List,
    field: str,
    template_id: str,
) -> List:
    """Replay adaptive structural trust ranking for a field."""
    trust_records = load_structural_trust(field=field)
    if not trust_records:
        return candidates

    for candidate in candidates:
        role = classify_role(field, candidate)
        sig = structural_signature(field, candidate)
        matches = [
            record for record in trust_records
            if record.get("field") == field
            and (
                record.get("structural_signature") == sig
                or (record.get("role") and record.get("role") == role)
            )
        ]
        if not matches:
            continue

        matches.sort(
            key=lambda record: (
                0 if record.get("adaptive_family") == template_id else 1,
                -float(record.get("trust_score") or 0.0),
            )
        )
        trust = matches[0]
        state = trust.get("trust_state", "neutral")
        trust_score = float(trust.get("trust_score") or 0.0)

        if field == "order_number" and not is_safe_order_number_candidate(candidate, sig):
            print(
                "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
                + json.dumps({
                    "field": field,
                    "candidate_value": candidate.value,
                    "candidate_role": role,
                    "candidate_signature": sig,
                    "trust_state": state,
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
            continue
        if field == "quantity" and not is_safe_quantity_candidate(candidate, [], {}):
            print(
                "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
                + json.dumps({
                    "field": field,
                    "candidate_value": candidate.value,
                    "candidate_role": role,
                    "candidate_signature": sig,
                    "trust_state": state,
                    "reason": "failed_quantity_safety",
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
            continue
        if field == "order_date" and not is_safe_order_date_candidate(candidate, [], {}, candidates):
            print(
                "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
                + json.dumps({
                    "field": field,
                    "candidate_value": candidate.value,
                    "candidate_role": role,
                    "candidate_signature": sig,
                    "trust_state": state,
                    "reason": "failed_order_date_safety",
                }, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )
            continue

        if state == "quarantined":
            candidate.score = -999
            candidate.penalties.append(f"structural_trust_quarantine:{role}(-inf)")
        elif state == "demoted":
            penalty = min(30.0, 6.0 + abs(trust_score) * 4.0)
            candidate.score -= penalty
            candidate.penalties.append(f"structural_trust_demoted:{role}(-{penalty:.1f})")
        elif state == "promoted":
            boost = min(16.0, 4.0 + trust_score * 4.0 + float(trust.get("universality_score") or 0.0) * 4.0)
            candidate.score += boost
            candidate.signals.append(f"structural_trust_promoted:{role}(+{boost:.1f})")
        else:
            candidate.signals.append(f"structural_trust_neutral:{role}")

        print(
            "[TRUST_REPLAY] "
            + json.dumps({
                "field": field,
                "candidate_value": candidate.value,
                "candidate_role": role,
                "candidate_signature": sig,
                "trust_state": state,
                "trust_score": trust_score,
                "confidence": trust.get("confidence", 0.0),
                "universality_score": trust.get("universality_score", 0.0),
                "adaptive_family": trust.get("adaptive_family", ""),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )

    return candidates


def _apply_order_number_final_safety(candidates: List, segment_map: Dict) -> List:
    """Prevent late learning/anchor paths from forcing unsafe order numbers."""
    for candidate in candidates:
        sig = build_extraction_signature(candidate, segment_map)
        if is_safe_order_number_candidate(candidate, sig):
            continue

        reasons = order_number_safety_reasons(candidate, sig)
        if getattr(candidate, "anchor_match", 0.0):
            candidate.anchor_match = 0.0
        if candidate.score > -999:
            candidate.score = -999
        candidate.penalties.append("order_number_final_safety_gate(-inf)")
        print(
            "[LEARNED_REPLAY_BLOCKED_BY_SAFETY] "
            + json.dumps({
                "field": "order_number",
                "candidate_value": candidate.value,
                "candidate_signature": sig,
                "reasons": reasons,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
    return candidates


def _select_order_number_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "order_number")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("order_number", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []

    for candidate in candidates:
        if getattr(candidate, "extractor", "") != "number_regex":
            continue

        confidence_sig = build_order_number_confidence_signature(candidate, segment_map)
        structural_sig = structural_signature("order_number", candidate)
        role = classify_role("order_number", candidate)
        reasons: List[str] = []

        if role != "order_header_number":
            reasons.append("role_not_order_header_number")
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        safety_reasons = order_number_safety_reasons(candidate, confidence_sig)
        if safety_reasons:
            reasons.append("failed_order_number_safety:" + ",".join(safety_reasons))

        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("role") == role
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_structural_trust")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "role": role,
                "block_reason": reasons,
            })
            continue

        rank = float(getattr(candidate, "score", 0.0)) + float(trust.get("trust_score") or 0.0)
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "order_number",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_order_number_0001",
        field_type="order_number",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_structural_order_number_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_structural_order_number_replay",
        "why_not_assigned": "",
        "block_reason": "",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
    }
    print(
        "[STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "order_number",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "trust_score": trust.get("trust_score", 0.0),
            "decision_source": "structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _load_assigned_fields(template_id: str, quantity_source: str = "") -> Dict[str, bool]:
    """Return a mapping field -> True for every field that has an active assignment."""
    assigned = {}
    for field in _ALL_FIELDS:
        source = quantity_source if field == "quantity" else None
        records = load_assignments(template_id, field, source=source)
        records = [
            record for record in records
            if _assignment_record_can_lock(field, record)
        ]
        assigned[field] = bool(records)
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
    signature = build_item_price_confidence_signature(candidate, segment_map, segments)
    return {
        "learned_signature": signature,
        "price_type": classify_price_type(candidate, segments),
        "nearby_label": _price_nearby_label(candidate, segments),
        "section_type": _price_section_type(candidate, segments),
        "context_class": _price_context_class(candidate, segments),
        "line_item_structure": _price_line_item_structure(candidate, segments),
        "positional_trust": _price_position_class(candidate, segments),
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
            "line_item_structure": meta["line_item_structure"],
            "positional_trust": meta["positional_trust"],
            "safe_item_price": is_safe_item_price_candidate(candidate, segments, segment_map),
            "item_price_safety_reasons": item_price_safety_reasons(candidate, segments, segment_map),
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
    "fee", "fees", "aggregate_total", "unknown_price",
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
        if (r.get("price_type") or r.get("context_class", "")) == "item_price"
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
            if not is_safe_item_price_candidate(candidate, segments, segment_map):
                continue
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


def _safe_item_price_candidates(candidates: List, segments: List[Any], segment_map: Dict) -> List:
    return [
        candidate for candidate in candidates
        if is_safe_item_price_candidate(candidate, segments, segment_map)
    ]


def _item_price_ambiguity_reason(candidates: List, selected, segments: List[Any], segment_map: Dict) -> str:
    safe = _safe_item_price_candidates(candidates, segments, segment_map)
    distinct_values = {candidate.value for candidate in safe}
    if len(distinct_values) <= 1:
        return ""
    same_score_or_higher = [
        candidate for candidate in safe
        if candidate.id != selected.id
        and candidate.value != selected.value
        and getattr(candidate, "score", 0.0) >= getattr(selected, "score", 0.0) - 1.0
    ]
    if same_score_or_higher:
        return "ambiguous_multiple_item_prices:" + ",".join(candidate.id for candidate in same_score_or_higher[:4])
    return ""


def _item_price_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    safety_reasons = item_price_safety_reasons(candidate, segments, segment_map)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)

    if classify_role("price", candidate) != "item_price":
        return "role_not_item_price"

    if confidence_signature == build_price_signature(candidate, segment_map, segments):
        return "legacy_or_generic_price_signature"

    ambiguity = _item_price_ambiguity_reason(candidates, candidate, segments, segment_map)
    if ambiguity:
        return ambiguity

    structural_sig = structural_signature("price", candidate)
    trust_records = load_structural_trust("price", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != "item_price":
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"

    return ""


def _promote_item_price_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("price", candidate)
    block_reason = _item_price_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[ITEM_PRICE_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "price",
                "target_subtype": "item_price",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    meta = _price_metadata(candidate, segments, segment_map)
    trust = update_structural_trust(
        template_id,
        "price",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": "item_price",
            "price_type": "item_price",
            "nearby_label": meta["nearby_label"],
            "section_type": meta["section_type"],
            "context_class": meta["context_class"],
            "relative_position": meta["relative_position"],
            "source": "safe_item_price_maturation",
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "price_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_item_price_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[ITEM_PRICE_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "price",
            "target_subtype": "item_price",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "why_promoted": "safe_item_price_structural_maturity",
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_price_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "price")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("price", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") == "item_price"
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    safe_candidates = _safe_item_price_candidates(candidates, segments, segment_map)
    if len({candidate.value for candidate in safe_candidates}) > 1:
        print(
            "[PRICE_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "price",
                "target_subtype": "item_price",
                "template_id": template_id,
                "block_reason": "ambiguous_multiple_item_prices",
                "candidates": [
                    {"candidate_id": candidate.id, "value": candidate.value}
                    for candidate in safe_candidates[:8]
                ],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []

    for candidate in candidates:
        confidence_sig = build_item_price_confidence_signature(candidate, segment_map, segments)
        structural_sig = structural_signature("price", candidate)
        reasons: List[str] = []
        safety_reasons = item_price_safety_reasons(candidate, segments, segment_map)
        if safety_reasons:
            reasons.append("failed_item_price_safety:" + ",".join(safety_reasons))
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_item_price_structural_trust")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "price_type": classify_price_type(candidate, segments),
                "block_reason": reasons,
            })
            continue

        rank = float(getattr(candidate, "score", 0.0)) + float(trust.get("trust_score") or 0.0)
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[PRICE_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "price",
                "target_subtype": "item_price",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_price_0001",
        field_type="price",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "price_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_structural_item_price_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="price_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "price_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_structural_item_price_replay",
        "why_not_assigned": "",
        "block_reason": "",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "maturity_state": "replayed",
    }
    print(
        "[PRICE_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "price",
            "target_subtype": "item_price",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "trust_score": trust.get("trust_score", 0.0),
            "decision_source": "price_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _safe_quantity_candidates(candidates: List, segments: List[Any], segment_map: Dict) -> List:
    return [
        candidate for candidate in candidates
        if is_safe_quantity_candidate(candidate, segments, segment_map)
    ]


def _quantity_ambiguity_reason(candidates: List, selected, segments: List[Any], segment_map: Dict) -> str:
    safe = _safe_quantity_candidates(candidates, segments, segment_map)
    distinct_values = {candidate.value for candidate in safe}
    if len(distinct_values) <= 1:
        return ""
    competitors = [
        candidate for candidate in safe
        if candidate.id != selected.id
        and candidate.value != selected.value
        and getattr(candidate, "score", 0.0) >= getattr(selected, "score", 0.0) - 1.0
    ]
    if competitors:
        return "ambiguous_multiple_quantities:" + ",".join(candidate.id for candidate in competitors[:4])
    return ""


def _quantity_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    safety_reasons = quantity_safety_reasons(candidate, segments, segment_map)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)

    qtype = _quantity_type(candidate, segments)
    if qtype not in _QUANTITY_SAFE_ROLES:
        return f"quantity_type_not_safe:{qtype}"

    legacy = build_quantity_signature(candidate, segment_map, " ".join(seg.text for seg in segments)) or build_extraction_signature(candidate, segment_map)
    if confidence_signature == legacy:
        return "legacy_or_generic_quantity_signature"

    ambiguity = _quantity_ambiguity_reason(candidates, candidate, segments, segment_map)
    if ambiguity:
        return ambiguity

    structural_sig = structural_signature("quantity", candidate)
    trust_records = load_structural_trust("quantity", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != qtype:
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"

    return ""


def _promote_quantity_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("quantity", candidate)
    qtype = _quantity_type(candidate, segments)
    block_reason = _quantity_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["quantity_type"] = qtype

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[QUANTITY_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "quantity",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "quantity_type": qtype,
                "why_not_promoted": block_reason,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "quantity",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": qtype,
            "quantity_type": qtype,
            "label_context": _quantity_label_context(candidate),
            "section_type": _quantity_section_type(candidate, segments),
            "nearby_signals": _quantity_nearby_signals(candidate, segments),
            "source": "safe_quantity_maturation",
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "quantity_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_quantity_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[QUANTITY_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "quantity",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "quantity_type": qtype,
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_quantity_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    clean_text: str,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "quantity")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("quantity", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") in _QUANTITY_SAFE_ROLES
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []
    for candidate in candidates:
        confidence_sig = build_quantity_confidence_signature(candidate, segment_map, segments, clean_text)
        structural_sig = structural_signature("quantity", candidate)
        qtype = _quantity_type(candidate, segments)
        reasons = quantity_safety_reasons(candidate, segments, segment_map)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
                or record.get("role") == qtype
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_quantity_structural_trust")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "quantity_type": qtype,
                "block_reason": reasons,
            })
            continue

        ambiguity = _quantity_ambiguity_reason(candidates, candidate, segments, segment_map)
        if ambiguity:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "quantity_type": qtype,
                "block_reason": [ambiguity],
            })
            continue

        rank = float(getattr(candidate, "score", 0.0)) + float(trust.get("trust_score") or 0.0)
        if qtype == "line_item_quantity":
            rank += 2.0
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[QUANTITY_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "quantity",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_quantity_0001",
        field_type="quantity",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "quantity_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_quantity_structural_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="quantity_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "quantity_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_quantity_structural_replay",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "quantity_type": _quantity_type(candidate, segments),
        "maturity_state": "replayed",
    }
    print(
        "[QUANTITY_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "quantity",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "quantity_type": _quantity_type(candidate, segments),
            "decision_source": "quantity_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _ship_by_trust_block_reason(
    template_id: str,
    candidate,
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    safety_reasons = ship_by_safety_reasons(candidate, segments, segment_map)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)
    if _ship_by_semantic_role(candidate, segments) != "ship_by_date":
        return "role_not_ship_by_date"
    if confidence_signature == build_extraction_signature(candidate, segment_map):
        return "legacy_or_generic_ship_by_signature"

    structural_sig = structural_signature("ship_by", candidate)
    trust_records = load_structural_trust("ship_by", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != "ship_by_date":
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"
    return ""


def _promote_ship_by_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("ship_by", candidate)
    block_reason = _ship_by_trust_block_reason(
        template_id,
        candidate,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["ship_by_role"] = _ship_by_semantic_role(candidate, segments)

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[SHIP_BY_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "ship_by",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "ship_by",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": "ship_by_date",
            "source": "safe_ship_by_maturation",
            "label_context": _ship_by_label_context(candidate, segments),
            "section_type": _ship_by_section_type(candidate, segments),
            "line_relation": _ship_by_line_confidence(candidate, segments),
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "ship_by_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_ship_by_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[SHIP_BY_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "ship_by",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_ship_by_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "ship_by")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("ship_by", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") == "ship_by_date"
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []
    for candidate in candidates:
        confidence_sig = build_ship_by_confidence_signature(candidate, segment_map, segments)
        structural_sig = structural_signature("ship_by", candidate)
        reasons = ship_by_safety_reasons(candidate, segments, segment_map)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
                or record.get("label_context") == _ship_by_label_context(candidate, segments)
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_ship_by_structural_trust")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "role": _ship_by_semantic_role(candidate, segments),
                "block_reason": reasons,
            })
            continue

        rank = float(getattr(candidate, "score", 0.0)) + float(trust.get("trust_score") or 0.0)
        if getattr(candidate, "source", "") == "subject":
            rank += 2.0
        if _ship_by_line_confidence(candidate, segments) == "same_line":
            rank += 1.0
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[SHIP_BY_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "ship_by",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_ship_by_0001",
        field_type="ship_by",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "ship_by_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_ship_by_structural_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="ship_by_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "ship_by_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_ship_by_structural_replay",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "ship_by_role": _ship_by_semantic_role(candidate, segments),
        "maturity_state": "replayed",
    }
    print(
        "[SHIP_BY_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "ship_by",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "decision_source": "ship_by_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _buyer_email_ambiguity_reason(candidates: List[Any], selected, segments: List[Any]) -> str:
    selected_priority = _buyer_email_source_priority(selected, candidates, segments)
    priority_rank = {
        "primary_customer": 0,
        "shipping_contact": 1,
        "billing_fallback": 2,
    }
    selected_rank = priority_rank.get(selected_priority, 9)
    safer = [
        candidate for candidate in candidates
        if candidate.id != selected.id
        and candidate.value != selected.value
        and not buyer_email_safety_reasons(candidate, candidates, segments)
        and priority_rank.get(_buyer_email_source_priority(candidate, candidates, segments), 9) <= selected_rank
        and getattr(candidate, "score", 0.0) >= getattr(selected, "score", 0.0) - 1.0
    ]
    if safer:
        return "safer_competing_buyer_email:" + ",".join(candidate.id for candidate in safer[:4])
    return ""


def _buyer_email_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    safety_reasons = buyer_email_safety_reasons(candidate, candidates, segments)
    if safety_reasons:
        return "safety:" + ",".join(safety_reasons)
    role = _buyer_email_role(candidate, segments)
    if role not in {"buyer_email", "shipping_contact_email", "billing_email"}:
        return f"role_not_buyer_email:{role}"
    if confidence_signature == build_extraction_signature(candidate, segment_map):
        return "legacy_or_generic_buyer_email_signature"
    ambiguity = _buyer_email_ambiguity_reason(candidates, candidate, segments)
    if ambiguity:
        return ambiguity

    structural_sig = structural_signature("buyer_email", candidate)
    trust_records = load_structural_trust("buyer_email", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != role:
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"
    return ""


def _promote_buyer_email_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("buyer_email", candidate)
    role = _buyer_email_role(candidate, segments)
    block_reason = _buyer_email_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["buyer_email_role"] = role

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[BUYER_EMAIL_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "buyer_email",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "buyer_email",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": role,
            "source": "safe_buyer_email_maturation",
            "label_context": _buyer_email_label_context(candidate, segments),
            "section_type": _buyer_email_section_type(candidate, segments),
            "domain_class": _buyer_email_domain_class(candidate),
            "local_part_class": _buyer_email_local_part_class(candidate),
            "source_priority": _buyer_email_source_priority(candidate, candidates, segments),
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "buyer_email_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_buyer_email_structural_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[BUYER_EMAIL_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "buyer_email",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "role": role,
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_buyer_email_structural_replay_candidate(
    template_id: str,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "buyer_email")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("buyer_email", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") in {"buyer_email", "shipping_contact_email", "billing_email"}
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]
    priority_rank = {
        "primary_customer": 0,
        "shipping_contact": 1,
        "billing_fallback": 2,
    }

    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []
    for candidate in candidates:
        confidence_sig = build_buyer_email_confidence_signature(candidate, segment_map, segments, candidates)
        structural_sig = structural_signature("buyer_email", candidate)
        role = _buyer_email_role(candidate, segments)
        reasons = buyer_email_safety_reasons(candidate, candidates, segments)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
                or (
                    record.get("role") == role
                    and record.get("label_context") == _buyer_email_label_context(candidate, segments)
                )
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_buyer_email_structural_trust")
        ambiguity = _buyer_email_ambiguity_reason(candidates, candidate, segments)
        if ambiguity:
            reasons.append(ambiguity)

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "role": role,
                "block_reason": reasons,
            })
            continue

        priority = _buyer_email_source_priority(candidate, candidates, segments)
        rank = (
            100.0
            - (priority_rank.get(priority, 9) * 10.0)
            + float(getattr(candidate, "score", 0.0))
            + float(trust.get("trust_score") or 0.0)
        )
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[BUYER_EMAIL_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "buyer_email",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_buyer_email_0001",
        field_type="buyer_email",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "buyer_email_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_buyer_email_structural_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="buyer_email_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "buyer_email_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_buyer_email_structural_replay",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "buyer_email_role": _buyer_email_role(candidate, segments),
        "source_priority": _buyer_email_source_priority(candidate, candidates, segments),
        "maturity_state": "replayed",
    }
    print(
        "[BUYER_EMAIL_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "buyer_email",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "decision_source": "buyer_email_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


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


def _select_lines_by_policy(candidate, learned_types: List[str], buyer_name: str = "") -> List[Dict[str, Any]]:
    learned_set = {line_type for line_type in learned_types if line_type}
    if not learned_set:
        return []
    lines = split_shipping_address_candidate_lines(candidate, buyer_name)
    primary_indices = [i for i, line in enumerate(lines) if line["type"] in learned_set]
    selected_lines = [lines[i] for i in primary_indices]
    present_types = {line["type"] for line in selected_lines}
    if not selected_lines or not learned_set.issubset(present_types):
        return []
    if primary_indices:
        first_idx, last_idx = primary_indices[0], primary_indices[-1]
        if last_idx > first_idx:
            selected_lines = [
                line for i, line in enumerate(lines)
                if line["type"] in learned_set
                or (first_idx < i < last_idx and line["type"] == "unknown")
            ]
    return selected_lines


def _shipping_address_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List,
    segments: List[Any],
    buyer_name: str,
    confidence_signature: str,
    selected_start: int | None = None,
    selected_end: int | None = None,
) -> str:
    reasons = shipping_address_safety_reasons(
        candidate,
        candidates,
        segments,
        buyer_name,
        selected_start,
        selected_end,
        explicit_policy=False,
    )
    if reasons:
        return "safety:" + ",".join(reasons)

    legacy_signature = build_shipping_address_signature(candidate, {seg.id: seg for seg in segments})
    if confidence_signature == legacy_signature:
        return "legacy_or_generic_address_signature"

    structural_sig = structural_signature("shipping_address", candidate)
    trust_records = load_structural_trust("shipping_address", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != "shipping_address_block":
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"

    return ""


def _promote_shipping_address_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    buyer_name: str,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("shipping_address", candidate)
    block_reason = _shipping_address_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        buyer_name,
        confidence_signature,
        None,
        None,
    )
    policy = _shipping_address_line_policy(candidate, None, None, buyer_name)

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["selected_line_types"] = policy["selected_line_types"]
    row.provenance["excluded_line_types"] = policy["excluded_line_types"]

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[SHIPPING_ADDRESS_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "shipping_address",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
                "selected_line_types": policy["selected_line_types"],
                "excluded_line_types": policy["excluded_line_types"],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "shipping_address",
        policy["selected_text"],
        {
            "value": policy["selected_text"],
            "segment_id": candidate.segment_id,
            "start": policy["selected_lines"][0].get("start") if policy["selected_lines"] else row.start,
            "end": policy["selected_lines"][-1].get("end") if policy["selected_lines"] else row.end,
            "selected_text": policy["selected_text"],
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": "shipping_address_block",
            "source": "safe_shipping_address_maturation",
            "learned_line_types": policy["selected_line_types"],
            "excluded_line_types": policy["excluded_line_types"],
            "line_count_pattern": policy["line_count"],
            "relative_position": _shipping_address_relative_position(candidate, segments),
        },
        "positive",
    )
    if policy["selected_text"]:
        row.value = policy["selected_text"]
        row.start = policy["selected_lines"][0].get("start")
        row.end = policy["selected_lines"][-1].get("end")
    row.decision = "assigned"
    row.decision_source = "shipping_address_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_shipping_address_line_policy_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[SHIPPING_ADDRESS_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "shipping_address",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "selected_line_types": policy["selected_line_types"],
            "excluded_line_types": policy["excluded_line_types"],
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_shipping_address_structural_replay_candidate(
    template_id: str,
    candidates: List,
    segments: List[Any],
    segment_map: Dict,
    buyer_name: str = "",
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "shipping_address")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("shipping_address", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") == "shipping_address_block"
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
        and record.get("learned_line_types")
    ]

    best: _Opt[tuple[float, Any, Dict[str, Any], str, str, List[Dict[str, Any]]]] = None
    blocked: List[Dict[str, Any]] = []

    for candidate in candidates:
        confidence_sig = build_shipping_address_confidence_signature(
            candidate,
            segment_map,
            segments,
            buyer_name,
        )
        structural_sig = structural_signature("shipping_address", candidate)
        reasons = shipping_address_safety_reasons(candidate, candidates, segments, buyer_name)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_shipping_address_structural_trust")

        selected_lines = _select_lines_by_policy(candidate, trust.get("learned_line_types", []) if trust else [], buyer_name)
        if trust is not None and not selected_lines:
            reasons.append("line_policy_not_satisfied")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "source": getattr(candidate, "source", ""),
                "block_reason": reasons,
            })
            continue

        rank = float(getattr(candidate, "score", 0.0)) + float(trust.get("trust_score") or 0.0)
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig, selected_lines)

    if best is None:
        print(
            "[SHIPPING_ADDRESS_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "shipping_address",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig, selected_lines = best
    final_output = "\n".join(line["text"] for line in selected_lines).strip()
    first_line = selected_lines[0]
    last_line = selected_lines[-1]
    replay = Candidate(
        id="structural_replay_shipping_address_0001",
        field_type="shipping_address",
        value=final_output,
        raw_text=final_output,
        start=first_line.get("start"),
        end=last_line.get("end"),
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "shipping_address_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_shipping_address_line_policy_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="shipping_address_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "shipping_address_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_shipping_address_line_policy_replay",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "learned_line_types": trust.get("learned_line_types", []),
        "selected_lines": [line["text"] for line in selected_lines],
        "maturity_state": "replayed",
    }
    print(
        "[SHIPPING_ADDRESS_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "shipping_address",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "learned_line_types": trust.get("learned_line_types", []),
            "decision_source": "shipping_address_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


def _buyer_name_trust_block_reason(
    template_id: str,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    confidence_signature: str,
) -> str:
    reasons = buyer_name_safety_reasons(candidate, candidates, segments)
    if reasons:
        return "safety:" + ",".join(reasons)

    if confidence_signature == build_extraction_signature(candidate, segment_map):
        return "legacy_or_generic_buyer_name_signature"

    structural_sig = structural_signature("buyer_name", candidate)
    role = _buyer_name_block_role(candidate, candidates)
    trust_records = load_structural_trust("buyer_name", template_id)
    for trust in trust_records:
        if trust.get("structural_signature") != structural_sig and trust.get("role") != role:
            continue
        if trust.get("quarantined") or trust.get("trust_state") in {"demoted", "quarantined"}:
            return f"trust_{trust.get('trust_state', 'blocked')}"

    return ""


def _promote_buyer_name_structural_maturity(
    template_id: str,
    row: DecisionRow,
    candidate,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
    streak: int,
    confidence_signature: str,
) -> bool:
    structural_sig = structural_signature("buyer_name", candidate)
    block_role = _buyer_name_block_role(candidate, candidates)
    block_reason = _buyer_name_trust_block_reason(
        template_id,
        candidate,
        candidates,
        segments,
        segment_map,
        confidence_signature,
    )

    row.provenance["maturity_progress"] = streak
    row.provenance["promotion_threshold"] = CONFIDENCE_PROMOTION_THRESHOLD
    row.provenance["confidence_signature"] = confidence_signature
    row.provenance["trust_signature"] = structural_sig
    row.provenance["recipient_role"] = block_role
    row.provenance["classification"] = _buyer_name_classification(candidate)

    if block_reason:
        row.provenance["why_not_promoted"] = block_reason
        row.provenance["maturity_state"] = "blocked"
        print(
            "[BUYER_NAME_MATURITY_BLOCKED] "
            + json.dumps({
                "field": "buyer_name",
                "value": row.value,
                "candidate_id": candidate.id,
                "maturity_progress": streak,
                "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
                "confidence_signature": confidence_signature,
                "trust_signature": structural_sig,
                "why_not_promoted": block_reason,
                "recipient_role": block_role,
                "classification": _buyer_name_classification(candidate),
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return False

    trust = update_structural_trust(
        template_id,
        "buyer_name",
        row.value,
        {
            "value": row.value,
            "segment_id": candidate.segment_id,
            "start": candidate.start,
            "end": candidate.end,
            "selected_text": candidate.raw_text,
            "segment_text": candidate.segment_text,
            "left_context": candidate.left_context,
            "right_context": candidate.right_context,
            "candidate_id": candidate.id,
            "extractor": candidate.extractor,
            "learned_signature": confidence_signature,
            "structural_signature": structural_sig,
            "role": block_role,
            "source": "safe_buyer_name_maturation",
            "relative_position": {
                "label_context": _buyer_name_label_context(candidate, segments),
                "line_position": _buyer_name_line_position(candidate, segments),
                "position_class": _buyer_name_position_class(candidate, segments),
                "classification": _buyer_name_classification(candidate),
                "variant": _buyer_name_variant(candidate),
            },
        },
        "positive",
    )
    row.decision = "assigned"
    row.decision_source = "buyer_name_structural_maturity_promotion"
    row.provenance["why_promoted"] = "safe_buyer_name_recipient_line_maturity"
    row.provenance["trust_state_transition"] = trust.get("trust_state", "")
    row.provenance["maturity_state"] = "promoted"
    print(
        "[BUYER_NAME_MATURITY_PROMOTED] "
        + json.dumps({
            "field": "buyer_name",
            "value": row.value,
            "candidate_id": candidate.id,
            "maturity_progress": streak,
            "promotion_threshold": CONFIDENCE_PROMOTION_THRESHOLD,
            "confidence_signature": confidence_signature,
            "trust_signature": structural_sig,
            "recipient_role": block_role,
            "classification": _buyer_name_classification(candidate),
            "trust_state_transition": trust.get("trust_state", ""),
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return True


def _select_buyer_name_structural_replay_candidate(
    template_id: str,
    candidates: List[Any],
    segments: List[Any],
    segment_map: Dict,
) -> _Opt[Candidate]:
    promoted_confidence = get_promoted_signature_records(template_id, "buyer_name")
    promoted_signatures = {
        record.get("extraction_signature", "")
        for record in promoted_confidence
        if record.get("extraction_signature", "")
    }
    trust_records = load_structural_trust("buyer_name", template_id)
    positive_trust = [
        record for record in trust_records
        if record.get("role") in {"shipping_recipient_name", "recipient_name", "billing_contact_name"}
        and record.get("trust_state") == "promoted"
        and float(record.get("trust_score") or 0.0) > 0
        and not record.get("quarantined", False)
        and record.get("adaptive_family", template_id) == template_id
    ]

    role_priority = {
        "shipping_recipient_name": 0,
        "recipient_name": 1,
        "billing_contact_name": 2,
        "contact_name": 3,
    }
    best: _Opt[tuple[float, Candidate, Dict[str, Any], str, str]] = None
    blocked: List[Dict[str, Any]] = []

    for candidate in candidates:
        confidence_sig = build_buyer_name_confidence_signature(candidate, segment_map, segments, candidates)
        structural_sig = structural_signature("buyer_name", candidate)
        block_role = _buyer_name_block_role(candidate, candidates)
        reasons = buyer_name_safety_reasons(candidate, candidates, segments)
        if confidence_sig not in promoted_signatures:
            reasons.append("confidence_signature_not_promoted")
        trust = next(
            (
                record for record in positive_trust
                if record.get("structural_signature") == structural_sig
                or record.get("learned_signature") == confidence_sig
                or record.get("role") == block_role
            ),
            None,
        )
        if trust is None:
            reasons.append("no_positive_buyer_name_structural_trust")

        if reasons:
            blocked.append({
                "candidate_id": candidate.id,
                "value": candidate.value,
                "confidence_signature": confidence_sig,
                "structural_signature": structural_sig,
                "source": getattr(candidate, "source", ""),
                "recipient_role": block_role,
                "classification": _buyer_name_classification(candidate),
                "block_reason": reasons,
            })
            continue

        rank = (
            100.0 - (role_priority.get(block_role, 9) * 10.0)
            + float(getattr(candidate, "score", 0.0))
            + float(trust.get("trust_score") or 0.0)
        )
        if best is None or rank > best[0]:
            best = (rank, candidate, trust, confidence_sig, structural_sig)

    if best is None:
        print(
            "[BUYER_NAME_STRUCTURAL_REPLAY_BLOCKED] "
            + json.dumps({
                "field": "buyer_name",
                "template_id": template_id,
                "promoted_signatures": sorted(promoted_signatures),
                "positive_trust_count": len(positive_trust),
                "blocked": blocked[:12],
            }, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return None

    _rank, candidate, trust, confidence_sig, structural_sig = best
    replay = Candidate(
        id="structural_replay_buyer_name_0001",
        field_type="buyer_name",
        value=candidate.value,
        raw_text=candidate.raw_text,
        start=candidate.start,
        end=candidate.end,
        segment_id=candidate.segment_id,
        extractor=candidate.extractor,
        signals=[
            "buyer_name_structural_replay_used",
            f"trust_signature={structural_sig}",
            f"confidence_signature={confidence_sig}",
            "why_assigned=trusted_buyer_name_recipient_line_replay",
        ],
        penalties=[],
        score=999,
        segment_text=candidate.segment_text,
        left_context=candidate.left_context,
        right_context=candidate.right_context,
        source="buyer_name_structural_trust_replay",
    )
    replay.provenance_extra = {
        "structural_replay_used": True,
        "buyer_name_structural_replay_used": True,
        "trust_signature": structural_sig,
        "confidence_signature": confidence_sig,
        "why_assigned": "trusted_buyer_name_recipient_line_replay",
        "trust_state": trust.get("trust_state", ""),
        "trust_score": trust.get("trust_score", 0.0),
        "recipient_role": _buyer_name_block_role(candidate, candidates),
        "classification": _buyer_name_classification(candidate),
        "maturity_state": "replayed",
    }
    print(
        "[BUYER_NAME_STRUCTURAL_REPLAY_ASSIGNED] "
        + json.dumps({
            "field": "buyer_name",
            "value": replay.value,
            "candidate_id": candidate.id,
            "confidence_signature": confidence_sig,
            "trust_signature": structural_sig,
            "recipient_role": _buyer_name_block_role(candidate, candidates),
            "decision_source": "buyer_name_structural_trust_replay",
        }, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )
    return replay


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
    if field == "order_number":
        safe_records = []
        for record in assigned_records:
            if _assignment_record_can_lock(field, record):
                safe_records.append(record)
            else:
                print(
                    "[ORDER_NUMBER_ASSIGNMENT_QUARANTINED] "
                    + json.dumps({
                        "value": record.get("value", ""),
                        "signature": record.get("learned_signature", ""),
                        "segment_text": record.get("segment_text", ""),
                        "reasons": order_number_safety_reasons(
                            _OrderNumberRecordProxy(record.get("value", ""), record),
                            record.get("learned_signature", ""),
                        ),
                    }, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                _log_assignment_blocked(field, record, "unsafe_order_number_assignment")
        assigned_records = safe_records
    else:
        safe_records = []
        for record in assigned_records:
            if _assignment_record_can_lock(field, record):
                safe_records.append(record)
            else:
                _log_assignment_blocked(field, record, "generic_signature_cannot_lock")
        assigned_records = safe_records
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

    if field != "quantity":
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
                if not is_safe_quantity_candidate(candidate, segments, {seg.id: seg for seg in segments}):
                    trace_rows.append({
                        "candidate_id": candidate.id,
                        "value": candidate.value,
                        "start": candidate.start,
                        "end": candidate.end,
                        "extractor": candidate.extractor,
                        "structural_score": round(structural_score, 4),
                        "extractor_bonus": round(extractor_bonus, 4),
                        "total_score": round(structural_score + extractor_bonus, 4),
                        "blocked": quantity_safety_reasons(candidate, segments, {seg.id: seg for seg in segments}),
                    })
                    continue
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

    def _replay_positions(search_value: str) -> List[int]:
        if field == "order_number" and re.fullmatch(r"\d+", search_value or ""):
            pattern = rf"(?<!\d){re.escape(search_value)}(?!\d)"
        else:
            pattern = re.escape(search_value)
        return [m.start() for m in re.finditer(pattern, clean_text)]

    def _order_number_replay_span_safe(span_start: int, span_end: int, replay_value: str) -> bool:
        if field != "order_number":
            return True
        line_start = clean_text.rfind("\n", 0, span_start) + 1
        line_end_raw = clean_text.find("\n", span_start)
        line_end = line_end_raw if line_end_raw != -1 else len(clean_text)
        replay_record = {
            "value": replay_value,
            "segment_text": clean_text[line_start:line_end],
            "left_context": clean_text[max(0, span_start - _CTX_WINDOW):span_start],
            "right_context": clean_text[span_end: span_end + _CTX_WINDOW],
            "extractor": "number_regex",
            "learned_signature": "number_regex|none|body",
        }
        if _order_number_record_is_safe(replay_value, replay_record):
            return True
        print(
            f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='unsafe_resolved_span'",
            file=sys.stderr,
            flush=True,
        )
        return False

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
            positions = _replay_positions(value)
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
            if not _order_number_replay_span_safe(start, end, value):
                continue
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
            positions = _replay_positions(preferred_text)
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
                    positions = _replay_positions(preferred_text)
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
                            positions = _replay_positions(value)
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
                positions = _replay_positions(preferred_text)
                resolved = _resolve_positions(positions, val_len, clean_text, record)
                if resolved is None:
                    print(
                        f"[LEARNED_REPLAY_EXACT_FAIL] field={field!r} reason='selected_text_not_found'",
                        file=sys.stderr,
                        flush=True,
                    )
                    val_len = len(value)
                    positions = _replay_positions(value)
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
                positions = _replay_positions(value)
                resolved = _resolve_positions(positions, val_len, clean_text, record)
                if resolved is None:
                    continue
                start, end = resolved, resolved + val_len

        # 5. No segment hint — search full clean_text with context scoring.
        else:
            positions = _replay_positions(value)
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
        if not _order_number_replay_span_safe(start, end, value):
            continue

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

    if field == "order_number":
        structural_candidate = _select_order_number_structural_replay_candidate(
            template_id,
            candidates,
            segment_map,
        )
        if structural_candidate is not None:
            return [structural_candidate]

    # Assignment exists but no position reached the confidence threshold.
    return []


def _field_is_rejected(template_id: str, field: str, source: str | None = None) -> bool:
    records = load_records(template_id, field=field, record_type="reject", source=source)
    if field in {"order_number", "price", "buyer_name"}:
        return False
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

    assignment_lock = {
        field: lock
        for field, lock in assignment_lock.items()
        if _assignment_record_can_lock(field, lock)
    }
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
    else:
        existing_assignments = load_assignments(template_id, field, source=source)
        existing_assignments = [
            record for record in existing_assignments
            if _assignment_record_can_lock(field, record)
        ]
        if not existing_assignments:
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
        if field == "quantity":
            safe_candidates = _safe_quantity_candidates(candidates, segments, {seg.id: seg for seg in segments})
            if safe_candidates:
                print(
                    "[STRICT_ASSIGNMENT_STALE_FALLBACK] "
                    + json.dumps({
                        "field": field,
                        "source": source or "",
                        "assignment_count": len(existing_assignments),
                        "safe_candidate_count": len(safe_candidates),
                        "selected_candidate_id": safe_candidates[0].id,
                        "selected_value": safe_candidates[0].value,
                        "stale_replay": True,
                        "hook": "stale_assignment_replay",
                    }, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                return safe_candidates, False
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
    business_timezone: str | None = None,
) -> Dict[str, Any]:
    ingested = load_eml(path, business_timezone=business_timezone)
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
        quantity_candidates = _apply_structural_trust(quantity_candidates, "quantity", template_family_id)
        _quantity_structural_replay_candidate = _select_quantity_structural_replay_candidate(
            template_family_id,
            quantity_candidates,
            segments,
            segment_map,
            clean_text,
        )
        if _quantity_structural_replay_candidate is not None:
            quantity_candidates = [_quantity_structural_replay_candidate]
            assignment_locked["quantity"] = True
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
        price_candidates = _apply_structural_rules(price_candidates, "price", template_family_id)
        price_candidates = _apply_structural_trust(price_candidates, "price", template_family_id)
        _price_structural_replay_candidate = _select_price_structural_replay_candidate(
            template_family_id,
            price_candidates,
            segments,
            segment_map,
        )
        if _price_structural_replay_candidate is not None:
            price_candidates = [_price_structural_replay_candidate]
            assignment_locked["price"] = True
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
        order_candidates = _apply_structural_rules(order_candidates, "order_number", template_family_id)
        order_candidates = _apply_structural_trust(order_candidates, "order_number", template_family_id)
        order_candidates = _apply_order_number_final_safety(order_candidates, segment_map)
        _structural_replay_candidate = _select_order_number_structural_replay_candidate(
            template_family_id,
            order_candidates,
            segment_map,
        )
        if _structural_replay_candidate is not None:
            order_candidates = [_structural_replay_candidate]
            assignment_locked["order_number"] = True
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
    # Body dates validated; subject/header dates have start=None/end=None and pass through.
    # Metadata support is intentionally limited to the Date header. Received headers are excluded for now.
    date_candidates = extract_order_date_from_subject(ingested.get("subject", ""))
    date_candidates += validate_candidates(extract_dates(segments), clean_text)
    date_candidates += extract_header_date(ingested.get("email_date", ""), ingested.get("header_date_provenance", {}))
    date_candidates = score_order_date(date_candidates, segments)
    date_candidates = _apply_order_date_safety(date_candidates, segments, segment_map)
    date_candidates, assignment_locked["order_date"] = _apply_assignment_policy(
        template_family_id, "order_date", date_candidates, segments, clean_text
    )
    if not assignment_locked["order_date"]:
        date_candidates = apply_anchor_scoring(template_family_id, "order_date", date_candidates)
        date_candidates = _apply_signature_scoring(date_candidates, template_family_id, "order_date", segment_map)
        date_candidates = _apply_structural_trust(date_candidates, "order_date", template_family_id)
        _order_date_structural_replay_candidate = _select_order_date_structural_replay_candidate(
            template_family_id,
            date_candidates,
            segments,
            segment_map,
        )
        if _order_date_structural_replay_candidate is not None:
            date_candidates = [_order_date_structural_replay_candidate]
            assignment_locked["order_date"] = True
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
        email_candidates = _apply_structural_trust(email_candidates, "buyer_email", template_family_id)
        email_candidates = _apply_buyer_email_safety(email_candidates, segments)
        _buyer_email_structural_replay_candidate = _select_buyer_email_structural_replay_candidate(
            template_family_id,
            email_candidates,
            segments,
            segment_map,
        )
        if _buyer_email_structural_replay_candidate is not None:
            email_candidates = [_buyer_email_structural_replay_candidate]
            assignment_locked["buyer_email"] = True
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
        ship_by_candidates = _apply_structural_trust(ship_by_candidates, "ship_by", template_family_id)
        _ship_by_structural_replay_candidate = _select_ship_by_structural_replay_candidate(
            template_family_id,
            ship_by_candidates,
            segments,
            segment_map,
        )
        if _ship_by_structural_replay_candidate is not None:
            ship_by_candidates = [_ship_by_structural_replay_candidate]
            assignment_locked["ship_by"] = True
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
        name_candidates = _apply_structural_rules(name_candidates, "buyer_name", template_family_id)
        name_candidates = _apply_structural_trust(name_candidates, "buyer_name", template_family_id)
        _buyer_name_structural_replay_candidate = _select_buyer_name_structural_replay_candidate(
            template_family_id,
            name_candidates,
            segments,
            segment_map,
        )
        if _buyer_name_structural_replay_candidate is not None:
            name_candidates = [_buyer_name_structural_replay_candidate]
            assignment_locked["buyer_name"] = True
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
        addr_candidates = _apply_structural_trust(addr_candidates, "shipping_address", template_family_id)
        _address_structural_replay_candidate = _select_shipping_address_structural_replay_candidate(
            template_family_id,
            addr_candidates,
            segments,
            segment_map,
            buyer_name=name_decision.value if name_decision else "",
        )
        if _address_structural_replay_candidate is not None:
            addr_candidates = [_address_structural_replay_candidate]
            assignment_locked["shipping_address"] = True
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
            if field in {"quantity", "price", "order_date"}:
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
            if field != "order_number" and not _is_structurally_valid(_ReplayProxy(value), field):
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
            if field == "order_number":
                line_start = clean_text.rfind("\n", 0, replay_start) + 1
                line_end_raw = clean_text.find("\n", replay_start)
                line_end = line_end_raw if line_end_raw != -1 else len(clean_text)
                replay_record = {
                    "value": value,
                    "segment_text": clean_text[line_start:line_end],
                    "left_context": clean_text[max(0, replay_start - _CTX_WINDOW):replay_start],
                    "right_context": clean_text[replay_end: replay_end + _CTX_WINDOW],
                    "extractor": "number_regex",
                    "learned_signature": "number_regex|none|body",
                }
                if not _order_number_record_is_safe(value, replay_record):
                    print(
                        f"[VALIDITY_GATE] replay skipped field={field!r} value={value!r}"
                        f" - failed order-number safety",
                        file=sys.stderr, flush=True,
                    )
                    continue

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
            else build_order_number_confidence_signature(c, segment_map)
            if c.field_type == "order_number"
            else build_ship_by_confidence_signature(c, segment_map, segments)
            if c.field_type == "ship_by"
            else build_order_date_confidence_signature(c, segment_map, segments, date_candidates)
            if c.field_type == "date"
            else build_buyer_email_confidence_signature(c, segment_map, segments, email_candidates)
            if c.field_type in {"email", "buyer_email"}
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
            if _row.field == "order_number":
                _cand_trace = next(
                    (c for c in all_candidates if c.id == _row.candidate_id), None
                )
                if _cand_trace is not None:
                    print(
                        "[ORDER_NUMBER_CONFIDENCE_SIGNATURE] "
                        + json.dumps(
                            _order_number_confidence_signature_trace(_cand_trace, segment_map),
                            ensure_ascii=False,
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
            if _row.field in _already_promoted:
                if _row.field == "buyer_email":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_buyer_email_confidence_signature_trace(
                            _cand_trace,
                            email_candidates,
                            segment_map,
                            segments,
                        ))
                    print(
                        "[BUYER_EMAIL_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "ship_by":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_ship_by_confidence_signature_trace(
                            _cand_trace,
                            segment_map,
                            segments,
                        ))
                    print(
                        "[SHIP_BY_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "quantity":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_quantity_confidence_signature_trace(
                            _cand_trace,
                            segment_map,
                            segments,
                            clean_text,
                        ))
                    print(
                        "[QUANTITY_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "order_number":
                    print(
                        "[ORDER_NUMBER_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps({
                            "field": _row.field,
                            "value": _row.value,
                            "reason": "read_only_parse_does_not_mutate_structural_trust",
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "price":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "target_subtype": "item_price",
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_item_price_confidence_signature_trace(_cand_trace, segment_map, segments))
                    print(
                        "[ITEM_PRICE_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "shipping_address":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_shipping_address_confidence_signature_trace(
                            _cand_trace,
                            addr_candidates,
                            segment_map,
                            segments,
                            buyer_name=name_decision.value if name_decision else "",
                        ))
                    print(
                        "[SHIPPING_ADDRESS_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                if _row.field == "buyer_name":
                    _cand_trace = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    payload = {
                        "field": _row.field,
                        "value": _row.value,
                        "reason": "read_only_parse_does_not_mutate_structural_trust",
                    }
                    if _cand_trace is not None:
                        payload.update(_buyer_name_confidence_signature_trace(
                            _cand_trace,
                            name_candidates,
                            segment_map,
                            segments,
                        ))
                    print(
                        "[BUYER_NAME_CONFIDENCE_MATURITY_PENDING] "
                        + json.dumps(payload, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
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
                _qty_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _qty_cand is None:
                    continue
                _trace = _quantity_confidence_signature_trace(_qty_cand, segment_map, segments, clean_text)
                print(
                    "[QUANTITY_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[QUANTITY_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "quantity",
                            "value": _row.value,
                            "candidate_id": _qty_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "price":
                _price_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _price_cand is None:
                    continue
                _trace = _item_price_confidence_signature_trace(_price_cand, segment_map, segments)
                print(
                    "[ITEM_PRICE_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[ITEM_PRICE_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "price",
                            "target_subtype": "item_price",
                            "value": _row.value,
                            "candidate_id": _price_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "shipping_address":
                _addr_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _addr_cand is None:
                    continue
                _trace = _shipping_address_confidence_signature_trace(
                    _addr_cand,
                    addr_candidates,
                    segment_map,
                    segments,
                    buyer_name=name_decision.value if name_decision else "",
                )
                print(
                    "[SHIPPING_ADDRESS_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[SHIPPING_ADDRESS_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "shipping_address",
                            "value": _row.value,
                            "candidate_id": _addr_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "buyer_name":
                _name_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _name_cand is None:
                    continue
                _trace = _buyer_name_confidence_signature_trace(
                    _name_cand,
                    name_candidates,
                    segment_map,
                    segments,
                )
                print(
                    "[BUYER_NAME_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[BUYER_NAME_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "buyer_name",
                            "value": _row.value,
                            "candidate_id": _name_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "ship_by":
                _ship_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _ship_cand is None:
                    continue
                _trace = _ship_by_confidence_signature_trace(
                    _ship_cand,
                    segment_map,
                    segments,
                )
                print(
                    "[SHIP_BY_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[SHIP_BY_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "ship_by",
                            "value": _row.value,
                            "candidate_id": _ship_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "order_date":
                _date_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _date_cand is None:
                    continue
                _trace = _order_date_confidence_signature_trace(
                    _date_cand,
                    segment_map,
                    segments,
                    date_candidates,
                )
                print(
                    "[ORDER_DATE_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["why_not_assigned"] = _row.provenance["why_not_promoted"]
                    _row.provenance["source_priority_used"] = _trace["source_type"]
                    _row.provenance["metadata_fallback_used"] = _trace["metadata_fallback_class"] == "header_only_no_safe_competitor"
                    _row.provenance["competing_date_block_reason"] = ",".join(
                        reason for reason in _trace["safety_reasons"] if "competitor" in reason or "metadata_fallback_blocked" in reason
                    )
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[ORDER_DATE_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "order_date",
                            "value": _row.value,
                            "candidate_id": _date_cand.id,
                            "source_priority_used": _row.provenance["source_priority_used"],
                            "metadata_fallback_used": _row.provenance["metadata_fallback_used"],
                            "competing_date_block_reason": _row.provenance["competing_date_block_reason"],
                            "why_not_assigned": _row.provenance["why_not_assigned"],
                            "maturity_state": "blocked",
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
            elif _row.field == "buyer_email":
                _email_cand = next((c for c in all_candidates if c.id == _row.candidate_id), None)
                if _email_cand is None:
                    continue
                _trace = _buyer_email_confidence_signature_trace(
                    _email_cand,
                    email_candidates,
                    segment_map,
                    segments,
                )
                print(
                    "[BUYER_EMAIL_CONFIDENCE_SIGNATURE] "
                    + json.dumps(_trace, ensure_ascii=False),
                    file=sys.stderr,
                    flush=True,
                )
                if not _trace["safe"]:
                    _row.provenance["why_not_promoted"] = "safety:" + ",".join(_trace["safety_reasons"])
                    _row.provenance["maturity_state"] = "blocked"
                    print(
                        "[BUYER_EMAIL_CONFIDENCE_BLOCKED] "
                        + json.dumps({
                            "field": "buyer_email",
                            "value": _row.value,
                            "candidate_id": _email_cand.id,
                            "block_reason": _row.provenance["why_not_promoted"],
                        }, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                    continue
                _sig = _trace["new_signature"]
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
                if _row.field == "order_number" and _cand_for_validity is not None:
                    _trace = _order_number_confidence_signature_trace(_cand_for_validity, segment_map)
                    _sig = _trace["new_signature"]
                    print(
                        "[ORDER_NUMBER_CONFIDENCE_SIGNATURE] "
                        + json.dumps(_trace, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )
                else:
                    _sig = _sig_map.get(_row.candidate_id) or _row.decision_source or "unknown"

            _streak, _promoted = update_streak(
                template_family_id,
                _row.field,
                _sig,
                _row.value,
                source=learning_source if _row.field == "quantity" else "",
            )

            if _promoted:
                if _row.field == "order_date":
                    _row.provenance["streak_count"] = _streak
                    _date_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _date_cand is None:
                        continue
                    _promote_order_date_structural_maturity(
                        template_family_id,
                        _row,
                        _date_cand,
                        date_candidates,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "buyer_email":
                    _row.provenance["streak_count"] = _streak
                    _email_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _email_cand is None:
                        continue
                    _promote_buyer_email_structural_maturity(
                        template_family_id,
                        _row,
                        _email_cand,
                        email_candidates,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "ship_by":
                    _row.provenance["streak_count"] = _streak
                    _ship_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _ship_cand is None:
                        continue
                    _promote_ship_by_structural_maturity(
                        template_family_id,
                        _row,
                        _ship_cand,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "quantity":
                    _row.provenance["streak_count"] = _streak
                    _qty_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _qty_cand is None:
                        continue
                    _promote_quantity_structural_maturity(
                        template_family_id,
                        _row,
                        _qty_cand,
                        quantity_candidates,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "order_number":
                    _row.provenance["streak_count"] = _streak
                    _order_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _order_cand is None:
                        continue
                    _promote_order_number_structural_maturity(
                        template_family_id,
                        _row,
                        _order_cand,
                        order_candidates,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "price":
                    _row.provenance["streak_count"] = _streak
                    _price_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _price_cand is None:
                        continue
                    _promote_item_price_structural_maturity(
                        template_family_id,
                        _row,
                        _price_cand,
                        price_candidates,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "shipping_address":
                    _row.provenance["streak_count"] = _streak
                    _addr_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _addr_cand is None:
                        continue
                    _promote_shipping_address_structural_maturity(
                        template_family_id,
                        _row,
                        _addr_cand,
                        addr_candidates,
                        segments,
                        segment_map,
                        name_decision.value if name_decision else "",
                        _streak,
                        _sig,
                    )
                    continue
                if _row.field == "buyer_name":
                    _row.provenance["streak_count"] = _streak
                    _name_cand = next(
                        (c for c in all_candidates if c.id == _row.candidate_id), None
                    )
                    if _name_cand is None:
                        continue
                    _promote_buyer_name_structural_maturity(
                        template_family_id,
                        _row,
                        _name_cand,
                        name_candidates,
                        segments,
                        segment_map,
                        _streak,
                        _sig,
                    )
                    continue
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
    trust_report = build_parser_trust_report_safe(
        path=path,
        clean_text=clean_text,
        segments=segments,
        segment_map=segment_map,
        candidates=all_candidates,
        decisions=validated_decisions,
        template_id=template_id,
        template_family_id=template_family_id,
        learning_source=learning_source,
        update_confidence=update_confidence,
    )

    return {
        "subject": ingested.get("subject", ""),
        "clean_text": clean_text,
        "segments": segments,
        "segment_map": segment_map,
        "candidates": all_candidates,
        "decisions": validated_decisions,
        "flags": flags,
        "meta": meta,
        "trust_report": trust_report,
        "template_id": template_id,
        "template_family_id": template_family_id,
        "learning_source": learning_source,
    }
