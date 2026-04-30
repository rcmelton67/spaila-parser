from parser.decide import decide_order_number, decide_shipping_address
from parser.extract import extract_buyer_name, extract_numbers, extract_shipping_address
from parser.score import score_order_number, score_shipping_address
from parser.segment import segment


def test_order_number_explicit_label_outranks_nearby_quantity():
    segs = segment(
        "Congratulations on your Etsy sale of 1 item.\n"
        "Your order number is: 4035149940\n"
        "Quantity: 1\n"
        "Price: $64.00\n"
    )

    scored = score_order_number(extract_numbers(segs), segs)
    decision = decide_order_number(scored)

    assert decision is not None
    assert decision.value == "4035149940"
    assert "explicit_order_label(+12.0)" in decision.provenance["signals"]


def test_four_digit_order_label_beats_repeated_zip():
    segs = segment(
        "Melton Memorials\n"
        "New order: #1928\n"
        "Order summary\n"
        "Order #1928 (December 1, 2025)\n"
        "Shipping address\n"
        "Brenda Espinosa\n"
        "1220 7th St NE\n"
        "Rochester, MN 55906\n"
        "Billing address\n"
        "Brenda Espinosa\n"
        "1220 7th St NE\n"
        "Rochester, MN 55906\n"
    )

    scored = score_order_number(extract_numbers(segs), segs)
    decision = decide_order_number(scored)
    zip_candidates = [c for c in scored if c.value == "55906"]

    assert decision is not None
    assert decision.value == "1928"
    assert any("explicit_order_label(+12.0)" in c.signals for c in scored if c.value == "1928")
    assert all(any("unsafe_order_number_address_or_postal" in p for p in c.penalties) for c in zip_candidates)


def test_woo_zip_failures_do_not_win_order_number():
    cases = [
        ("1933", "Lake Dallas, TX 75065"),
        ("1935", "Texarkana, TX 75501"),
        ("1959", "Bradenton, FL 34203"),
    ]

    for order_id, city_state_zip in cases:
        segs = segment(
            f"New order: #{order_id}\n"
            "Order summary\n"
            f"Order #{order_id} (December 5, 2025)\n"
            "Shipping address\n"
            "Sample Buyer\n"
            "123 Main Street\n"
            f"{city_state_zip}\n"
            "Billing address\n"
            "Sample Buyer\n"
            "123 Main Street\n"
            f"{city_state_zip}\n"
        )
        decision = decide_order_number(score_order_number(extract_numbers(segs), segs))

        assert decision is not None
        assert decision.value == order_id


def test_invoice_and_purchase_four_digit_ids_are_supported():
    for label in ("Invoice 1234", "Purchase 5678", "#2468"):
        segs = segment(f"{label}\nShipping address\nJane Buyer\n10 Main St\nAustin, TX 78701\n")
        decision = decide_order_number(score_order_number(extract_numbers(segs), segs))

        assert decision is not None
        assert decision.value in label


def test_address_block_numbers_are_not_order_numbers_without_order_support():
    segs = segment(
        "Shipping address\n"
        "Jane Buyer\n"
        "1234 Main Street\n"
        "Austin, TX 78701\n"
        "Quantity: 1\n"
        "Price: $20.00\n"
    )

    decision = decide_order_number(score_order_number(extract_numbers(segs), segs))

    assert decision is None


def test_shipping_source_candidate_outranks_billing_source_candidate():
    """When billing and shipping blocks are both present, the decision should
    be the shipping block, not the billing block."""
    clean_text = (
        "Billing address\n"
        "123 Main St\n"
        "Austin, TX 78701\n"
        "Shipping address\n"
        "456 Oak Ave\n"
        "Denver, CO 80202\n"
    )
    segs = segment(clean_text)
    candidates = extract_shipping_address(segs)
    scored = score_shipping_address(candidates, segs)
    decision = decide_shipping_address(scored)

    assert decision is not None
    assert "456 Oak Ave" in decision.value, "shipping-block address must win"
    assert "123 Main St" not in decision.value, "billing-block address must not win"


def test_shipping_block_stops_at_section_labels_and_keeps_recipient_line():
    clean_text = (
        "Shipping address\n"
        "Rachel Loftus-Jungwirth\n"
        "16684 Markley Lake Dr SE\n"
        "PRIOR LAKE, MN 55372-1998\n"
        "United States\n"
        "Purchase Shipping Label\n"
        "Shipping internationally?\n"
        "Order total\n"
    )
    segs = segment(clean_text)

    name_candidates = extract_buyer_name(segs)
    assert [candidate.value for candidate in name_candidates] == ["Rachel Loftus-Jungwirth"]

    scored_addresses = score_shipping_address(extract_shipping_address(segs), segs)
    decision = decide_shipping_address(scored_addresses)

    assert decision is not None
    assert decision.value == (
        "Rachel Loftus-Jungwirth\n"
        "16684 Markley Lake Dr SE\n"
        "PRIOR LAKE, MN 55372-1998\n"
        "United States"
    )
