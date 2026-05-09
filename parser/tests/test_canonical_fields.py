"""
Regression tests for the canonical field contract and alias normalization.

Covers:
- Alias mapping (buyer_name, buyer_email, shipping_name)
- normalize_field_key identity for canonical keys
- normalize_order_dict priority rules
- is_legacy_field gating
- Parser decision_rows never emit buyer_name / buyer_email / shipping_name
"""

import pytest
from parser.canonical_fields import (
    normalize_field_key,
    normalize_order_dict,
    is_legacy_field,
    LEGACY_ALIAS_MAP,
    CANONICAL_FIELDS,
)


# ---------------------------------------------------------------------------
# 1. Alias mapping
# ---------------------------------------------------------------------------

class TestNormalizeFieldKey:
    def test_buyer_name_maps_to_billing_name(self):
        assert normalize_field_key("buyer_name") == "billing_name"

    def test_buyer_email_maps_to_billing_email(self):
        assert normalize_field_key("buyer_email") == "billing_email"

    def test_shipping_name_maps_to_recipient_name(self):
        assert normalize_field_key("shipping_name") == "recipient_name"

    def test_canonical_keys_pass_through(self):
        for key in CANONICAL_FIELDS:
            assert normalize_field_key(key) == key

    def test_unknown_key_passes_through(self):
        assert normalize_field_key("some_custom_field") == "some_custom_field"

    def test_all_legacy_aliases_covered(self):
        expected = {"buyer_name", "buyer_email", "shipping_name"}
        assert set(LEGACY_ALIAS_MAP.keys()) == expected


# ---------------------------------------------------------------------------
# 2. normalize_order_dict
# ---------------------------------------------------------------------------

class TestNormalizeOrderDict:
    def test_renames_buyer_name(self):
        result = normalize_order_dict({"buyer_name": "Alice"})
        assert result["billing_name"] == "Alice"
        assert "buyer_name" not in result

    def test_canonical_wins_over_legacy(self):
        # billing_name is already set; buyer_name should be ignored
        result = normalize_order_dict({
            "billing_name": "Alice (canonical)",
            "buyer_name": "Bob (legacy)",
        })
        assert result["billing_name"] == "Alice (canonical)"
        assert "buyer_name" not in result

    def test_legacy_promotes_when_canonical_absent(self):
        result = normalize_order_dict({"buyer_email": "test@example.com"})
        assert result["billing_email"] == "test@example.com"

    def test_non_legacy_keys_preserved(self):
        result = normalize_order_dict({
            "order_number": "#1234",
            "ship_by": "2024-01-01",
        })
        assert result["order_number"] == "#1234"
        assert result["ship_by"] == "2024-01-01"

    def test_full_mixed_payload(self):
        payload = {
            "buyer_name": "Bob",
            "billing_name": "Alice",
            "buyer_email": "bob@example.com",
            "billing_email": "alice@example.com",
            "shipping_name": "Charlie",
            "recipient_name": "Dana",
            "order_number": "#999",
        }
        result = normalize_order_dict(payload)
        assert result["billing_name"] == "Alice"   # canonical wins
        assert result["billing_email"] == "alice@example.com"  # canonical wins
        assert result["recipient_name"] == "Dana"  # canonical wins
        assert result["order_number"] == "#999"
        assert "buyer_name" not in result
        assert "buyer_email" not in result
        assert "shipping_name" not in result


# ---------------------------------------------------------------------------
# 3. is_legacy_field
# ---------------------------------------------------------------------------

class TestIsLegacyField:
    def test_buyer_name_is_legacy(self):
        assert is_legacy_field("buyer_name") is True

    def test_buyer_email_is_legacy(self):
        assert is_legacy_field("buyer_email") is True

    def test_shipping_name_is_legacy(self):
        assert is_legacy_field("shipping_name") is True

    def test_billing_name_is_not_legacy(self):
        assert is_legacy_field("billing_name") is False

    def test_recipient_name_is_not_legacy(self):
        assert is_legacy_field("recipient_name") is False

    def test_order_number_is_not_legacy(self):
        assert is_legacy_field("order_number") is False


# ---------------------------------------------------------------------------
# 4. Parser decision_rows never emit legacy fields
# ---------------------------------------------------------------------------

try:
    from parser.pipeline import run_parser
    PIPELINE_AVAILABLE = True
except ImportError:
    PIPELINE_AVAILABLE = False


ETSY_SHIPPING_BLOCK = """
Hi, you have a new order!

Order #12345
Order date: May 1, 2025

SHIPPING ADDRESS
Ryan Bowen
22436 72nd Ave
S KENT, WA 98032
United States

Items: Custom pet memorial
Quantity: 1
Price: $45.00
"""

WOOCOMMERCE_SAMPLE = """
New order received.

Billing
Alice Smith
123 Main St
Seattle, WA 98101

Email: alice@example.com
Phone: 555-1234

Order #WC-789
Date: 2025-05-01

Shipping
Bob Jones
456 Elm Ave
Tacoma, WA 98402
"""


@pytest.mark.skipif(not PIPELINE_AVAILABLE, reason="parser pipeline not importable in this context")
class TestParserDecisionRowsCanonical:
    def _get_decisions(self, text):
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(text)
            path = f.name
        try:
            result = run_parser(path, update_confidence=False)
        finally:
            os.unlink(path)
        return result.get("decisions", [])

    def test_no_buyer_name_in_decisions(self):
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        fields = [d["field"] for d in decisions]
        assert "buyer_name" not in fields, f"buyer_name should not appear in decisions: {fields}"

    def test_no_buyer_email_in_decisions(self):
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        fields = [d["field"] for d in decisions]
        assert "buyer_email" not in fields, f"buyer_email should not appear in decisions: {fields}"

    def test_no_shipping_name_in_decisions(self):
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        fields = [d["field"] for d in decisions]
        assert "shipping_name" not in fields, f"shipping_name should not appear in decisions: {fields}"

    def test_etsy_shipping_block_recipient_name(self):
        """Ryan Bowen inside SHIPPING ADDRESS block = recipient_name."""
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        by_field = {d["field"]: d for d in decisions}
        assert "recipient_name" in by_field, f"recipient_name missing from decisions: {list(by_field)}"
        assert "Ryan Bowen" in by_field["recipient_name"]["value"]

    def test_etsy_shipping_block_billing_name_not_ryan_bowen(self):
        """billing_name must not be set to Ryan Bowen (shipping recipient)."""
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        by_field = {d["field"]: d for d in decisions}
        if "billing_name" in by_field:
            assert "Ryan Bowen" not in by_field["billing_name"]["value"], (
                "billing_name incorrectly assigned shipping recipient name"
            )

    def test_etsy_shipping_address_lines(self):
        """Street/city/state/zip inside shipping block = shipping_address."""
        decisions = self._get_decisions(ETSY_SHIPPING_BLOCK)
        by_field = {d["field"]: d for d in decisions}
        if "shipping_address" in by_field:
            addr = by_field["shipping_address"]["value"]
            assert "22436" in addr or "KENT" in addr, f"Unexpected shipping address: {addr!r}"


# ---------------------------------------------------------------------------
# 5. Learning store alias migration
# ---------------------------------------------------------------------------

class TestLearningStoreAliases:
    def test_buyer_name_not_in_trust_fields(self):
        from parser.learning.store import TRUST_FIELDS
        assert "buyer_name" not in TRUST_FIELDS, (
            "buyer_name should not be a trust field; use billing_name"
        )

    def test_buyer_email_not_in_trust_fields(self):
        from parser.learning.store import TRUST_FIELDS
        assert "buyer_email" not in TRUST_FIELDS, (
            "buyer_email should not be a trust field; use billing_email"
        )

    def test_buyer_name_not_in_core_fields(self):
        from parser.learning.store import CORE_FIELDS
        assert "buyer_name" not in CORE_FIELDS, (
            "buyer_name should not be a core field; use billing_name"
        )

    def test_buyer_email_not_in_core_fields(self):
        from parser.learning.store import CORE_FIELDS
        assert "buyer_email" not in CORE_FIELDS, (
            "buyer_email should not be a core field; use billing_email"
        )
