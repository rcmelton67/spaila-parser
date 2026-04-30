import re
from typing import Any, Dict

from .order_number_safety import (
    CITY_STATE_ZIP_RE,
    ZIP_RE,
    has_address_or_postal_context,
    has_explicit_order_support,
)


GENERIC_HARD_LOCK_SIGNATURES = frozenset({
    "number_regex|none|body",
    "number_regex|none|order_block",
    "address_label_block|none|body",
    "address_label_name|none|body",
})

_PHONE_RE = re.compile(r"^\+?\d{10,15}$")
_SKU_RE = re.compile(r"\b(?:sku|#mm-|product|item|variation|listing)\b", re.IGNORECASE)
_PRICE_RE = re.compile(r"\$\s*\d|\b(?:price|subtotal|total|tax|shipping)\b", re.IGNORECASE)
_QTY_RE = re.compile(r"\b(?:qty|quantity|items?)\b|\bx\s*\d\b", re.IGNORECASE)
_DATE_RE = re.compile(
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|"
    r"march|april|june|july|august|september|october|november|december)\b|"
    r"\b\d{1,2}/\d{1,2}/\d{2,4}\b",
    re.IGNORECASE,
)
_LABELISH_NAME_RE = re.compile(
    r"\b(?:purchase shipping label|shipping label|free shipping|payment method|order summary|customer note)\b",
    re.IGNORECASE,
)
_STORE_NAME_RE = re.compile(r"\b(?:store|shop|llc|inc|company|memorials)\b", re.IGNORECASE)


def _get(obj: Any, key: str, default: str = "") -> str:
    if isinstance(obj, dict):
        value = obj.get(key, default)
    else:
        value = getattr(obj, key, default)
    return "" if value is None else str(value)


def candidate_context(candidate: Any) -> str:
    return " ".join(
        part for part in (
            _get(candidate, "left_context"),
            _get(candidate, "segment_text") or _get(candidate, "raw_text"),
            _get(candidate, "right_context"),
        )
        if part
    )


def classify_role(field: str, candidate: Any) -> str:
    value = _get(candidate, "value").strip()
    segment = _get(candidate, "segment_text") or _get(candidate, "raw_text")
    context = candidate_context(candidate)
    signature = _get(candidate, "learned_signature")

    if field == "order_number":
        if has_explicit_order_support(candidate):
            return "order_header_number"
        if has_address_or_postal_context(candidate):
            if CITY_STATE_ZIP_RE.search(segment):
                return "city_state_zip_line"
            if ZIP_RE.fullmatch(value):
                return "postal_code"
            return "address_numeric"
        if _PHONE_RE.fullmatch(value):
            return "phone"
        if _PRICE_RE.search(context):
            return "price"
        if _DATE_RE.search(context):
            return "date"
        if _SKU_RE.search(context) or _QTY_RE.search(context):
            return "sku_product_quantity"
        if signature in GENERIC_HARD_LOCK_SIGNATURES or _get(candidate, "extractor") == "number_regex":
            return "generic_number"
        return "unknown_order_number"

    if field == "price":
        price_type = _get(candidate, "price_type")
        if price_type:
            return price_type
        if has_explicit_order_support(candidate):
            return "order_number"
        if has_address_or_postal_context(candidate) or ZIP_RE.fullmatch(value):
            return "zip"
        if _QTY_RE.search(context):
            return "quantity"
        if _PRICE_RE.search(context):
            lowered = context.lower()
            if "tax" in lowered:
                return "tax"
            if "shipping" in lowered:
                return "shipping"
            if "total" in lowered or "subtotal" in lowered:
                return "aggregate_total"
            return "item_price"
        return "unknown_price"

    if field == "buyer_name":
        if _LABELISH_NAME_RE.search(context):
            return "label_text"
        if _STORE_NAME_RE.search(value):
            return "store_name"
        if "shipping" in context.lower():
            return "shipping_method_text"
        return "person_name"

    if field == "buyer_email":
        lowered = context.lower()
        if "billing" in lowered:
            return "billing_email"
        if "shipping" in lowered:
            return "shipping_email"
        if "customer" in lowered or "buyer" in lowered or "email" in lowered:
            return "buyer_email"
        return "email_address"

    if field == "shipping_address":
        lowered = context.lower()
        if "shipping address" in lowered or "ship to" in lowered:
            return "shipping_address_block"
        if "billing address" in lowered:
            return "billing_address_block"
        if has_address_or_postal_context(candidate):
            return "address_block"
        return "unknown_address"

    if field == "order_date":
        lowered = context.lower()
        if "ship by" in lowered or "ships by" in lowered or "dispatch by" in lowered or "estimated ship" in lowered:
            return "ship_by_date"
        if "deliver" in lowered or "arrival" in lowered or "arrive" in lowered:
            return "delivery_date"
        if "paid" in lowered or "payment" in lowered or "charged" in lowered:
            return "payment_date"
        if "tracking" in lowered or "carrier" in lowered or "label created" in lowered:
            return "tracking_date"
        if "invoice due" in lowered or "due date" in lowered or "due by" in lowered:
            return "invoice_due_date"
        if "browser" in lowered or "unsubscribe" in lowered or "support" in lowered or "privacy" in lowered:
            return "footer_date"
        if "date:" in lowered or "sent" in lowered:
            return "metadata_fallback_date"
        if (
            "order date" in lowered
            or "ordered on" in lowered
            or "order placed" in lowered
            or "placed on" in lowered
            or "purchase date" in lowered
            or "purchased on" in lowered
        ):
            return "explicit_order_date"
        if "order summary" in lowered or "order details" in lowered or "order #" in lowered or "order number" in lowered:
            return "order_summary_date"
        return "generic_unlabeled_date"

    if field == "ship_by":
        lowered = context.lower()
        if "ship by" in lowered or "dispatch" in lowered:
            return "ship_by_date"
        if "deliver" in lowered:
            return "delivery_date"
        return "date"

    if field == "quantity":
        lowered = context.lower()
        if "quantity" in lowered or "qty" in lowered:
            return "quantity_label"
        if "×" in context or re.search(r"\bx\s*\d\b", lowered):
            return "line_item_quantity"
        if "items" in lowered:
            return "item_count"
        return "number"

    return "unknown"


def structural_signature(field: str, candidate: Any) -> str:
    extractor = _get(candidate, "extractor") or "unknown"
    role = classify_role(field, candidate)
    segment = (_get(candidate, "segment_text") or _get(candidate, "raw_text")).lower()
    label = "none"
    for token in (
        "new order", "order number", "order", "invoice", "purchase",
        "shipping address", "billing address", "price", "quantity", "tax",
        "shipping", "subtotal", "total",
    ):
        if token in segment:
            label = re.sub(r"[^a-z0-9]+", "_", token).strip("_")
            break
    return f"{field}|{extractor}|{label}|{role}"


def rule_matches_candidate(rule: Dict[str, Any], candidate: Any) -> bool:
    role = classify_role(rule.get("field", ""), candidate)
    sig = structural_signature(rule.get("field", ""), candidate)
    value = _get(candidate, "value")
    return (
        bool(rule.get("active", True))
        and (
            (rule.get("structural_signature") and rule.get("structural_signature") == sig)
            or (rule.get("role") and rule.get("role") == role)
            or (rule.get("value") and rule.get("value") == value)
        )
    )
