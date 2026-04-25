import re
from typing import List, Dict, Optional
from .models import Candidate, Segment

_SUMMARY_WORDS = (
    "subtotal", "total", "tax", "shipping", "s&h", "discount", "payment"
)

_THRESHOLD_WORDS = ("over", "above", "minimum", "at least", "or more", "orders of")

_ADDRESS_WORDS = ("address", "city", "state", "zip", "usa")

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]

_STRUCTURED_QTY_RE = re.compile(r"(?:^|\b)(?:quantity|qty)\s*[:#-]?\s*\d+\b", re.IGNORECASE)
_QTY_SYMBOL_RE = re.compile(r"(?:^|\s)[x×]\s*\d+\b", re.IGNORECASE)
_SENTENCE_QTY_RE = re.compile(r"\b(?:sale of|you sold)\s+\d+\s+items?\b", re.IGNORECASE)
_PRODUCT_ROW_HINTS = ("price", "item total", "product", "item", "line item")

# Price-specific patterns
_SENTENCE_PRICE_RE = re.compile(r"\b(?:sale of|you sold|sold)\s+\d+\s+items?\b", re.IGNORECASE)
_CURRENCY_VALUE_RE = re.compile(r"\$\s*\d+(?:[.,]\d+)?")  # explicit $XX or $XX.XX

# Woo price location signals
# Positive: words that appear near the *correct* line-item price
_PRICE_POSITIVE_WORDS: tuple = ("item", "price", "each", "per", "line item", "product", "sku")
# Positive: words that indicate the candidate is INSIDE a line-item block
_LINE_ITEM_BLOCK_WORDS: tuple = ("qty", "quantity", "product", "sku", "listing", "each", "per unit")
# Negative: aggregate / summary context words that indicate the WRONG total row
_PRICE_TOTAL_CONTEXT_WORDS: tuple = (
    "order total", "grand total", "order subtotal",
    "cart total", "checkout total",
)
_EXPLICIT_ORDER_NUMBER_RE = re.compile(
    r"\b(?:your\s+)?order(?:\s+number)?\s*(?:is|#|number)?\s*[:#-]?\s*(\d{5,})\b",
    re.IGNORECASE,
)


def score_quantity(candidates: List[Candidate], segments: List[Segment]) -> List[Candidate]:
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}
    seg_list = segments  # ordered, for proximity check

    for cand in candidates:
        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        text_lower = seg.text.lower()
        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        # --- POSITIVE SIGNALS ---

        if "×" in seg.text or " x" in text_lower:
            score += 4.0
            signals.append("quantity_symbol(+4.0)")

        if any(word in text_lower for word in ("quantity", "qty")):
            score += 3.0
            signals.append("quantity_label(+3.0)")

        if _STRUCTURED_QTY_RE.search(seg.text):
            score += 4.0
            signals.append("structured_quantity_line(+4.0)")

        if _QTY_SYMBOL_RE.search(seg.text):
            score += 3.0
            signals.append("structured_quantity_symbol(+3.0)")

        if seg.text.strip() == cand.raw_text.strip():
            score += 1.5
            signals.append("standalone_line(+1.5)")

        # nearby alignment: ±2 segments contain "quantity" or "qty"
        cand_idx = next(
            (i for i, s in enumerate(seg_list) if s.id == cand.segment_id), None
        )
        if cand_idx is not None:
            nearby = seg_list[max(0, cand_idx - 2): cand_idx] + \
                     seg_list[cand_idx + 1: cand_idx + 3]
            if any(
                word in s.text.lower()
                for s in nearby
                for word in ("quantity", "qty")
            ):
                score += 2.5
                signals.append("nearby_quantity_label(+2.5)")

            if any(
                any(hint in s.text.lower() for hint in _PRODUCT_ROW_HINTS)
                for s in nearby
            ):
                score += 1.5
                signals.append("near_product_or_price(+1.5)")

        try:
            num_val = float(cand.value)
            if num_val == int(num_val) and 1 <= int(num_val) <= 20:
                score += 0.5
                signals.append("small_integer(+0.5)")
        except ValueError:
            pass

        # --- NEGATIVE SIGNALS ---

        if any(month in text_lower for month in MONTHS):
            score -= 4.0
            penalties.append("date_context(−4.0)")

        if "(" in seg.text and ")" in seg.text:
            score -= 2.5
            penalties.append("parenthesis_context(−2.5)")

        if _SENTENCE_QTY_RE.search(seg.text):
            score -= 4.0
            penalties.append("sentence_quantity_context(−4.0)")

        try:
            int_val = int(cand.value)
            if len(cand.value) == 4 and 1900 <= int_val <= 2100:
                score -= 3.0
                penalties.append("year_like(−3.0)")
        except ValueError:
            pass


        if len(cand.raw_text) > 5:
            score -= 2.0
            penalties.append("long_number(−2.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return candidates


def _is_plain_integer(value: str) -> bool:
    """True when value is a whole number with no decimal/comma separator."""
    return bool(re.fullmatch(r"\d+", value))


def _has_dollar_prefix(cand: Candidate) -> bool:
    """True when the value is immediately preceded by a '$' sign in its segment."""
    return "$" in cand.left_context


def score_price(
    candidates: List[Candidate],
    segments: List[Segment],
    quantity_candidates: List[Candidate],
) -> List[Candidate]:
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}
    seg_index: Dict[str, int] = {s.id: i for i, s in enumerate(segments)}

    # only use positively-scored quantity candidates for proximity signals
    strong_qty = [c for c in quantity_candidates if c.score > 0]

    qty_seg_indices = {
        seg_index[c.segment_id]
        for c in strong_qty
        if c.segment_id in seg_index
    }

    # anchor: segment index of the highest-scoring quantity candidate
    best_qty_idx: Optional[int] = (
        seg_index.get(max(strong_qty, key=lambda c: c.score).segment_id)
        if strong_qty else None
    )

    scored: List[Candidate] = []

    for cand in candidates:
        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        text_lower = seg.text.lower()

        # ------------------------------------------------------------------
        # HARD FILTERS — reject before scoring
        # ------------------------------------------------------------------

        # Plain integers < 10 with no dollar prefix are never valid prices.
        # This eliminates quantity-sized numbers ("1", "2") that leak into
        # price candidates when the email contains "sale of 1 item" etc.
        if _is_plain_integer(cand.value):
            try:
                int_val = int(cand.value)
                if int_val < 10 and not _has_dollar_prefix(cand):
                    continue
            except ValueError:
                pass

        # Sentence-based numbers ("sale of 1 item", "you sold 2 items") are
        # quantity descriptions, never prices.
        if _SENTENCE_PRICE_RE.search(seg.text):
            continue

        # ------------------------------------------------------------------
        # Normal scoring
        # ------------------------------------------------------------------

        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        cand_idx = seg_index.get(cand.segment_id)

        # --- POSITIVE SIGNALS ---

        # Explicit $XX.XX pattern in the segment → strong currency evidence
        if _CURRENCY_VALUE_RE.search(seg.text):
            score += 5.0
            signals.append("explicit_currency_pattern(+5.0)")
        elif "$" in seg.text:
            score += 2.0
            signals.append("currency_symbol(+2.0)")

        # Value itself carries a $ prefix → direct monetary value
        if _has_dollar_prefix(cand):
            score += 3.0
            signals.append("dollar_prefix(+3.0)")

        # Decimal value (XX.XX) is the canonical price format
        if "." in cand.value or "," in cand.value:
            score += 2.0
            signals.append("decimal_value(+2.0)")

        if cand_idx is not None and qty_seg_indices and \
                any(abs(cand_idx - q_idx) <= 2 for q_idx in qty_seg_indices):
            score += 5.0
            signals.append("near_quantity(+5.0)")
        else:
            score -= 2.0
            penalties.append("no_quantity_context(−2.0)")

        if len(seg.text) > 20 and not any(w in text_lower for w in _THRESHOLD_WORDS):
            score += 1.5
            signals.append("row_context(+1.5)")

        if cand_idx is not None and best_qty_idx is not None and \
                cand_idx == best_qty_idx + 1:
            score += 2.0
            signals.append("aligned_with_quantity(+2.0)")

        # --- NEW: line-item proximity boost (+4) ---
        # Boost when the candidate or its ±3 segment window contains
        # positive line-item label words (item / price / each / product …).
        if cand_idx is not None:
            window_segs = segments[max(0, cand_idx - 3): cand_idx + 4]
            window_text_lower = " ".join(s.text.lower() for s in window_segs)
            if any(w in window_text_lower for w in _PRICE_POSITIVE_WORDS):
                score += 4.0
                signals.append("line_item_proximity(+4.0)")

            # --- NEW: inside line-item block boost (+3) ---
            # Extra boost when the same window also contains qty/sku/product
            # signals, confirming this is a product-row price, not a summary.
            if any(w in window_text_lower for w in _LINE_ITEM_BLOCK_WORDS):
                score += 3.0
                signals.append("inside_line_item_block(+3.0)")

        # --- NEGATIVE SIGNALS ---

        if any(word in text_lower for word in _SUMMARY_WORDS):
            score -= 6.0
            penalties.append("summary_section(−6.0)")

        if len(text_lower.strip()) < 10:
            score -= 2.0
            penalties.append("isolated_currency(−2.0)")

        # Plain integer without any currency context → penalise heavily
        if _is_plain_integer(cand.value) and "$" not in seg.text:
            score -= 3.5
            penalties.append("integer_no_currency(−3.5)")
        elif _is_plain_integer(cand.value):
            score -= 2.5
            penalties.append("no_decimal(−2.5)")

        if cand_idx is not None:
            nearby_prices = [
                x for x in candidates
                if x.id != cand.id
                and ("." in x.value or "," in x.value)
                and seg_index.get(x.segment_id) is not None
                and abs(seg_index[x.segment_id] - cand_idx) <= 3
            ]
            if len(nearby_prices) > 2:
                score -= 2.0
                penalties.append("crowded_price_region(−2.0)")

        # --- NEW: aggregate-total context penalty (−5) ---
        # Penalise candidates whose ±3 segment window contains explicit
        # "order total" / "grand total" phrases that mark a summary row.
        if cand_idx is not None:
            nearby_total_text = " ".join(
                s.text.lower()
                for s in segments[max(0, cand_idx - 3): cand_idx + 4]
            )
            if any(phrase in nearby_total_text for phrase in _PRICE_TOTAL_CONTEXT_WORDS):
                score -= 5.0
                penalties.append("near_order_total(−5.0)")
        # Also penalise when the SEGMENT ITSELF mentions these exact phrases
        # (catches totals that the broader window scan might miss).
        if any(phrase in text_lower for phrase in _PRICE_TOTAL_CONTEXT_WORDS):
            score -= 5.0
            penalties.append("segment_is_total(−5.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score
        scored.append(cand)

    return scored


def score_order_number(
    candidates: List[Candidate],
    segments: List[Segment],
) -> List[Candidate]:
    seg_index: Dict[str, int] = {s.id: i for i, s in enumerate(segments)}
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}

    # pre-compute value frequency across all candidates
    value_counts: Dict[str, int] = {}
    for c in candidates:
        value_counts[c.value] = value_counts.get(c.value, 0) + 1

    _order_keywords = ("order", "order #", "order number")

    for cand in candidates:
        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        i = seg_index[cand.segment_id]
        window = segments[max(0, i - 2): i + 3]
        window_text = " ".join(s.text.lower() for s in window)
        text_lower = seg.text.lower()

        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        # --- POSITIVE SIGNALS ---

        explicit_match = _EXPLICIT_ORDER_NUMBER_RE.search(seg.text)
        if explicit_match and explicit_match.group(1) == cand.value:
            score += 12.0
            signals.append("explicit_order_label(+12.0)")

        if any(word in window_text for word in _order_keywords):
            score += 6.0
            signals.append("order_keyword_near(+6.0)")

        if 6 <= len(cand.value) <= 12:
            score += 2.0
            signals.append("length_valid(+2.0)")

        if cand.value.strip() == seg.text.strip():
            score += 1.5
            signals.append("standalone(+1.5)")

        if value_counts.get(cand.value, 0) > 1:
            score += 3.0
            signals.append("repeated_value(+3.0)")

        if "order_keyword_near(+6.0)" in signals and "repeated_value(+3.0)" in signals:
            score += 2.0
            signals.append("keyword_repeat_bonus(+2.0)")

        # --- NEGATIVE SIGNALS ---

        if any(word in text_lower for word in _ADDRESS_WORDS):
            score -= 4.0
            penalties.append("address_context(−4.0)")

        if "$" in seg.text:
            score -= 5.0
            penalties.append("currency_context(−5.0)")

        if "." in cand.value:
            score -= 4.0
            penalties.append("decimal_not_id(−4.0)")

        if len(cand.value) < 5:
            score -= 3.0
            penalties.append("too_short(−3.0)")

        if any(month in text_lower for month in MONTHS):
            score -= 4.0
            penalties.append("date_context(−4.0)")

        if len(cand.value) > 6 and not any(word in window_text for word in _order_keywords):
            score -= 2.0
            penalties.append("no_order_context(−2.0)")

        if "quantity" in text_lower or re.search(r"\bitems?\b", text_lower):
            score -= 4.0
            penalties.append("quantity_item_context(−4.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return candidates


_ORDER_DATE_KEYWORDS = ("order", "order date", "order summary")
_SHIPPING_WORDS = ("ship", "delivery", "arrive")


def score_order_date(
    date_candidates: List[Candidate],
    segments: List[Segment],
) -> List[Candidate]:
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}
    seg_index: Dict[str, int] = {s.id: i for i, s in enumerate(segments)}
    total_segs = max(len(segments), 1)
    order_candidate_indices = [
        i for i, seg in enumerate(segments)
        if "order" in seg.text.lower()
    ]

    for cand in date_candidates:
        if getattr(cand, "source", "") == "header":
            score = 0.0
            signals: List[str] = []
            penalties: List[str] = []

            score += 2.0
            signals.append("header_date_base(+2.0)")

            cand.signals = signals
            cand.penalties = penalties
            cand.score = score
            continue

        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        i = seg_index[cand.segment_id]
        window = segments[max(0, i - 2): i + 3]
        window_text = " ".join(s.text.lower() for s in window)
        text_lower = seg.text.lower()

        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        # --- POSITIVE SIGNALS ---

        if any(word in window_text for word in _ORDER_DATE_KEYWORDS):
            score += 5.0
            signals.append("order_date_context(+5.0)")

        if order_candidate_indices and any(abs(i - idx) <= 2 for idx in order_candidate_indices):
            score += 3.0
            signals.append("near_order_number(+3.0)")

        if "(" in seg.text and ")" in seg.text:
            score += 3.0
            signals.append("parenthesis_date(+3.0)")

        if len(seg.text.strip()) < 40:
            score += 1.5
            signals.append("compact_date_line(+1.5)")

        position_bonus = max(0.0, 2.0 - (i / total_segs) * 2.0)
        if position_bonus > 0:
            score += position_bonus
            signals.append(f"early_position_bias(+{position_bonus:.2f})")

        # --- NEGATIVE SIGNALS ---

        if "paid" in text_lower or "payment" in text_lower:
            score -= 5.0
            penalties.append("payment_context(−5.0)")

        if any(word in text_lower for word in _SHIPPING_WORDS):
            score -= 4.0
            penalties.append("shipping_context(−4.0)")

        if "browser time" in window_text or "tracking" in window_text:
            score -= 3.0
            penalties.append("unrelated_section(−3.0)")

        if "unsubscribe" in text_lower:
            score -= 3.0
            penalties.append("footer_context(−3.0)")

        if not any(word in window_text for word in _ORDER_DATE_KEYWORDS):
            score -= 2.0
            penalties.append("no_order_context(−2.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return date_candidates


_CUSTOMER_WORDS = ("customer", "buyer", "from", "email", "shipping", "address")
_FOOTER_WORDS = ("support", "help", "contact", "unsubscribe")
_SELLER_DOMAINS = ("meltonmemorials.com", "meltonmemorials@gmail.com")
_MARKETPLACE_DOMAINS = ("etsy.com", "amazon.com", "shopify.com")
_SYSTEM_PATTERNS = ("noreply", "no-reply", "do-not-reply")
_SHIP_BY_KEYWORDS = ("ship by", "ships by", "dispatch by", "estimated ship")
_ORDER_DATE_CONTEXT_WORDS = ("order date", "paid", "payment")


def score_buyer_email(
    email_candidates: List[Candidate],
    segments: List[Segment],
) -> List[Candidate]:
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}
    seg_index: Dict[str, int] = {s.id: i for i, s in enumerate(segments)}

    value_counts: Dict[str, int] = {}
    for c in email_candidates:
        value_counts[c.value] = value_counts.get(c.value, 0) + 1

    for cand in email_candidates:
        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        i = seg_index[cand.segment_id]
        window = segments[max(0, i - 5): i + 6]
        window_text = " ".join(s.text.lower() for s in window)
        text_lower = seg.text.lower()
        value_lower = cand.value.lower()

        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        # --- POSITIVE SIGNALS ---

        if any(word in window_text for word in _CUSTOMER_WORDS):
            score += 4.0
            signals.append("customer_context(+4.0)")

        if any(any(char.isalpha() for char in s.text) for s in window):
            score += 1.5
            signals.append("name_nearby(+1.5)")

        if "customer_context(+4.0)" in signals and "name_nearby(+1.5)" in signals:
            score += 2.0
            signals.append("identity_alignment(+2.0)")

        if value_counts.get(cand.value, 0) == 1:
            score += 1.0
            signals.append("unique_email(+1.0)")

        # --- NEGATIVE SIGNALS ---

        if any(p in value_lower for p in _SYSTEM_PATTERNS):
            score -= 5.0
            penalties.append("system_email(−5.0)")

        if any(d in value_lower for d in _SELLER_DOMAINS):
            score -= 6.0
            penalties.append("seller_email(−6.0)")

        if any(word in text_lower for word in _FOOTER_WORDS):
            score -= 4.0
            penalties.append("footer_context(−4.0)")

        if any(d in value_lower for d in _MARKETPLACE_DOMAINS):
            score -= 3.0
            penalties.append("marketplace_email(−3.0)")

        if len(window_text.strip()) < 20:
            score -= 2.0
            penalties.append("isolated_email(−2.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return email_candidates


def score_ship_by(
    ship_by_candidates: List[Candidate],
    segments: List[Segment],
    price_candidates: List[Candidate],
    order_candidates: List[Candidate],
    subject: str = "",
) -> List[Candidate]:
    seg_map: Dict[str, Segment] = {s.id: s for s in segments}
    seg_index: Dict[str, int] = {s.id: i for i, s in enumerate(segments)}
    total_segs = max(len(segments), 1)

    strong_price_indices = {
        seg_index[c.segment_id]
        for c in price_candidates
        if c.score > 0 and c.segment_id in seg_index
    }
    strong_order_indices = {
        seg_index[c.segment_id]
        for c in order_candidates
        if c.score > 0 and c.segment_id in seg_index
    }

    for cand in ship_by_candidates:
        if cand.source == "subject":
            text = subject or cand.segment_text
            text_lower = text.lower()
            score = 0.0
            signals: List[str] = []
            penalties: List[str] = []

            if any(keyword in text_lower for keyword in _SHIP_BY_KEYWORDS):
                score += 5.0
                signals.append("ship_by_keyword(+5.0)")

            score += 3.0
            signals.append("subject_source(+3.0)")

            if "order" in text_lower or "$" in text_lower:
                score += 2.0
                signals.append("near_order_or_price(+2.0)")
            else:
                score -= 2.0
                penalties.append("far_from_keyword(−2.0)")

            score += 1.0
            signals.append("early_position(+1.0)")

            if any(word in text_lower for word in _ORDER_DATE_CONTEXT_WORDS):
                score -= 3.0
                penalties.append("order_date_context(−3.0)")

            cand.signals = signals
            cand.penalties = penalties
            cand.score = score
            continue

        seg = seg_map.get(cand.segment_id)
        if seg is None:
            continue

        text_lower = seg.text.lower()
        score = 0.0
        signals = []
        penalties = []
        cand_idx = seg_index.get(cand.segment_id)

        if any(keyword in text_lower for keyword in _SHIP_BY_KEYWORDS):
            score += 5.0
            signals.append("ship_by_keyword(+5.0)")

        if cand.source == "subject":
            score += 3.0
            signals.append("subject_source(+3.0)")

        if cand_idx is not None and (
            any(abs(cand_idx - idx) <= 2 for idx in strong_price_indices)
            or any(abs(cand_idx - idx) <= 2 for idx in strong_order_indices)
        ):
            score += 2.0
            signals.append("near_order_or_price(+2.0)")

        if cand_idx is not None and cand_idx <= max(2, total_segs // 10):
            score += 1.0
            signals.append("early_position(+1.0)")

        if any(word in text_lower for word in _ORDER_DATE_CONTEXT_WORDS):
            score -= 3.0
            penalties.append("order_date_context(−3.0)")

        if not any(keyword in text_lower for keyword in _SHIP_BY_KEYWORDS):
            penalties.append("far_from_keyword(−2.0)")
            score -= 2.0

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return ship_by_candidates


_STREET_SUFFIXES = (
    " dr", " rd", " st", " ave", " blvd", " ln", " way", " ct", " pl",
    " ter", " pkwy", " hwy", " cir", " loop", " sq",
)


def score_buyer_name(
    candidates: List[Candidate],
    segments: List[Segment],
) -> List[Candidate]:
    value_counts: Dict[str, int] = {}
    for c in candidates:
        value_counts[c.value] = value_counts.get(c.value, 0) + 1

    for cand in candidates:
        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        if getattr(cand, "source", "") == "shipping":
            score += 5.0
            signals.append("shipping_label_context(+5.0)")
        elif getattr(cand, "source", "") == "billing":
            score += 3.0
            signals.append("billing_label_context(+3.0)")

        if value_counts.get(cand.value, 0) > 1:
            score += 2.0
            signals.append("name_repeated(+2.0)")

        word_count = len(cand.value.split())
        if word_count >= 2:
            score += 1.0
            signals.append("full_name(+1.0)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return candidates


def score_shipping_address(
    candidates: List[Candidate],
    segments: List[Segment],
) -> List[Candidate]:
    for cand in candidates:
        score = 0.0
        signals: List[str] = []
        penalties: List[str] = []

        score += 5.0
        signals.append("shipping_label_context(+5.0)")

        val_lower = cand.value.lower()
        if any(val_lower.endswith(suf) or (suf + " ") in val_lower for suf in _STREET_SUFFIXES):
            score += 2.0
            signals.append("street_suffix(+2.0)")

        if cand.extractor == "address_block_with_recipient":
            score += 1.5
            signals.append("recipient_line_included(+1.5)")

        cand.signals = signals
        cand.penalties = penalties
        cand.score = score

    return candidates
