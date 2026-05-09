"""
Canonical field contract for Spaila order identity.

All parser outputs, UI reads, and DB writes use these canonical keys.
Legacy (buyer-era) keys are mapped here via LEGACY_ALIAS_MAP and must
never appear in decision_rows, learning records, or API payloads.
"""

from typing import Dict

# --- Canonical order fields ---
CANONICAL_ORDER_FIELDS = (
    # Order core
    "order_number",
    "order_date",
    "ship_by",
    # Billing / Purchaser
    "billing_name",
    "billing_address",
    "billing_email",
    "phone_number",
    # Shipping / Recipient
    "recipient_name",
    "shipping_address",
    # Line items
    "quantity",
    "price",
)

CANONICAL_FIELDS: frozenset = frozenset(CANONICAL_ORDER_FIELDS)

# --- Legacy → canonical key mapping ---
# These legacy keys must NEVER appear in decision_rows or learning records.
LEGACY_ALIAS_MAP: Dict[str, str] = {
    "buyer_name":    "billing_name",
    "buyer_email":   "billing_email",
    "shipping_name": "recipient_name",
}

# Reverse map: canonical → legacy (for backward-compat DB writes only)
CANONICAL_TO_LEGACY_MAP: Dict[str, str] = {v: k for k, v in LEGACY_ALIAS_MAP.items()}


def normalize_field_key(key: str) -> str:
    """
    Normalize a potentially-legacy field key to its canonical equivalent.

    Examples
    --------
    >>> normalize_field_key("buyer_name")
    'billing_name'
    >>> normalize_field_key("billing_name")
    'billing_name'
    >>> normalize_field_key("shipping_name")
    'recipient_name'
    >>> normalize_field_key("order_number")
    'order_number'
    """
    return LEGACY_ALIAS_MAP.get(key, key)


def normalize_order_dict(order: Dict) -> Dict:
    """
    Return a copy of *order* with all legacy field keys replaced by their
    canonical equivalents.  Canonical keys already present take priority.

    Two-pass: canonical keys are written first, then legacy promotions fill
    in only keys not already set by a canonical source.

    This is the single normalization gate that any inbound payload (parser
    result, API body, DB row) should pass through before business logic
    touches it.
    """
    result = {}
    # Pass 1: copy non-legacy (canonical + unknown) keys as-is
    for key, value in order.items():
        if key not in LEGACY_ALIAS_MAP:
            result[key] = value
    # Pass 2: promote legacy keys only when the canonical target is absent
    for key, value in order.items():
        if key in LEGACY_ALIAS_MAP:
            canonical = LEGACY_ALIAS_MAP[key]
            if canonical not in result:
                result[canonical] = value
    return result


def is_legacy_field(key: str) -> bool:
    """Return True if *key* is a legacy alias that should not be user-facing."""
    return key in LEGACY_ALIAS_MAP
