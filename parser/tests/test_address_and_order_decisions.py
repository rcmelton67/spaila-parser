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
