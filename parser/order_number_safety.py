import re
from typing import Any


GENERIC_NUMBER_SIGNATURES = frozenset({
    "number_regex|none|body",
    "number_regex|none|order",
    "number_regex|none|header",
    "number_regex|none|shipping",
    "number_regex|none|pricing",
    "number_regex|none|buyer",
})

EXPLICIT_ORDER_LABEL_RE = re.compile(
    r"(?:"
    r"(?:new\s+)?order(?:\s+(?:number|id|#))?"
    r"|invoice(?:\s+(?:number|id|#))?"
    r"|purchase(?:\s+(?:number|id|#))?"
    r"|receipt(?:\s+(?:number|id|#))?"
    r")\s*(?:is|number|no\.?|id|#)?\s*[:#-]?\s*#?\s*([A-Z0-9][A-Z0-9-]{2,})\b",
    re.IGNORECASE,
)
HASH_ID_RE = re.compile(r"(?<![A-Z0-9])#\s*([0-9]{4,})(?![A-Z0-9])", re.IGNORECASE)
ZIP_RE = re.compile(r"^\d{5}(?:-\d{4})?$")
ZIP_ANYWHERE_RE = re.compile(r"\b\d{5}(?:-\d{4})?\b")
CITY_STATE_ZIP_RE = re.compile(
    r"\b[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b"
)
STATE_ZIP_RE = re.compile(r"\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b")
STREET_RE = re.compile(
    r"\b\d+[A-Za-z0-9#.\-]*\s+[\w#.'-]+(?:\s+[\w#.'-]+){0,8}\s+"
    r"(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|pl|place|"
    r"blvd|boulevard|way|loop|cir|circle|pkwy|parkway|hwy|highway|ter|terrace)\b",
    re.IGNORECASE,
)
ADDRESS_LABEL_RE = re.compile(
    r"\b(?:shipping|billing|ship\s+to|bill\s+to|delivery|recipient|postal|zip|postcode|address)\b",
    re.IGNORECASE,
)
PRICE_OR_QTY_RE = re.compile(
    r"[$]\s*\d|\b(?:qty|quantity|price|subtotal|total|tax|shipping)\b|[xX]\s*\d",
    re.IGNORECASE,
)
DATE_CONTEXT_RE = re.compile(
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|"
    r"march|april|june|july|august|september|october|november|december)\b|"
    r"\b\d{1,2}/\d{1,2}/\d{2,4}\b",
    re.IGNORECASE,
)


def _text(candidate: Any, attr: str) -> str:
    if isinstance(candidate, dict):
        value = candidate.get(attr, "")
        return "" if value is None else str(value)
    value = getattr(candidate, attr, "")
    return "" if value is None else str(value)


def order_number_context_text(candidate: Any) -> str:
    return " ".join(
        part for part in (
            _text(candidate, "left_context"),
            _text(candidate, "segment_text") or _text(candidate, "raw_text"),
            _text(candidate, "right_context"),
        )
        if part
    )


def has_explicit_order_support(candidate: Any) -> bool:
    value = (_text(candidate, "value") or _text(candidate, "raw_text")).strip()
    if not value:
        return False
    segment = _text(candidate, "segment_text") or _text(candidate, "raw_text")
    context = order_number_context_text(candidate)
    for search_text in (segment, context):
        for match in EXPLICIT_ORDER_LABEL_RE.finditer(search_text):
            if match.group(1).strip().strip("#") == value:
                return True
        for match in HASH_ID_RE.finditer(search_text):
            if match.group(1).strip() == value and not has_address_or_postal_context(candidate):
                return True
    return False


def has_address_or_postal_context(candidate: Any) -> bool:
    value = _text(candidate, "value").strip()
    segment = _text(candidate, "segment_text") or _text(candidate, "raw_text")
    context = order_number_context_text(candidate)

    if CITY_STATE_ZIP_RE.search(segment) or STATE_ZIP_RE.search(segment):
        return True
    if STREET_RE.search(segment):
        return True
    if ZIP_RE.fullmatch(value) and (
        CITY_STATE_ZIP_RE.search(context)
        or STATE_ZIP_RE.search(context)
        or ADDRESS_LABEL_RE.search(context)
        or STREET_RE.search(context)
    ):
        return True
    if ZIP_RE.fullmatch(value) and ZIP_ANYWHERE_RE.search(segment) and "," in segment:
        return True
    return False


def order_number_safety_reasons(candidate: Any, signature: str = "") -> list[str]:
    value = _text(candidate, "value").strip()
    segment = _text(candidate, "segment_text") or _text(candidate, "raw_text")
    context = order_number_context_text(candidate)
    reasons: list[str] = []

    if not value:
        reasons.append("empty")
        return reasons
    if "." in value:
        reasons.append("decimal")
    if len(value) < 3:
        reasons.append("too_short")
    if has_address_or_postal_context(candidate):
        reasons.append("address_or_postal_context")
    if PRICE_OR_QTY_RE.search(segment):
        reasons.append("price_or_quantity_context")
    if DATE_CONTEXT_RE.search(segment) and not has_explicit_order_support(candidate):
        reasons.append("date_context_without_order_label")

    generic_signature = signature in GENERIC_NUMBER_SIGNATURES or (
        not signature and _text(candidate, "extractor") == "number_regex"
    )
    if generic_signature and not has_explicit_order_support(candidate):
        reasons.append("generic_number_without_order_support")

    return reasons


def is_safe_order_number_candidate(candidate: Any, signature: str = "") -> bool:
    return not order_number_safety_reasons(candidate, signature)
