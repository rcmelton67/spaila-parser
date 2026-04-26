from pathlib import Path

import pytest

from parser.pipeline import parse_eml
from parser.pipeline import (
    _apply_price_rejections,
    build_price_signature,
    build_shipping_address_line_learning,
    classify_price_type,
    _price_context_class,
    _price_nearby_label,
    _price_relative_position,
    _price_section_type,
)
from parser.models import Candidate
from parser.extract import extract_numbers
from parser.score import score_price, score_quantity
from parser.ui_bridge import apply_learning
from parser.replay.fingerprint import compute_template_id
from parser.learning import confidence_store
from parser.learning import store as learning_store

ASSIGN_DECISIONS = {"assign", "assigned"}
SUGGEST_DECISIONS = {"suggest", "suggested"}
MISSING_DECISIONS = {"missing"}
VALID_DECISIONS = ASSIGN_DECISIONS | SUGGEST_DECISIONS | MISSING_DECISIONS


def _make_eml(path: Path, body: str, subject: str = "Order update") -> str:
    path.write_text(
        "From: seller@example.com\n"
        "To: buyer@example.com\n"
        f"Subject: {subject}\n"
        "Date: Fri, 10 Apr 2026 12:00:00 -0500\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain; charset=utf-8\n\n"
        f"{body}\n",
        encoding="utf-8",
    )
    return str(path)


def _assert_decision_state_contract(decision, clean_text, sample_path):
    effective_decision = "missing" if decision.start is None or decision.end is None else decision.decision
    effective_value = "" if effective_decision in MISSING_DECISIONS else decision.value
    print(
        "[TEST_DECISION_STATE] "
        f"field={decision.field} decision={decision.decision} "
        f"effective_decision={effective_decision} "
        f"value={decision.value!r} start={decision.start!r} end={decision.end!r}"
    )
    assert decision.decision in VALID_DECISIONS, (
        f"{sample_path} {decision.field} has unexpected decision state: {decision.decision}"
    )

    if decision.start is None or decision.end is None:
        assert effective_decision in MISSING_DECISIONS, (
            f"{sample_path} {decision.field} has no range but effective state is {effective_decision}"
        )
        assert effective_value in (None, ""), (
            f"{sample_path} {decision.field} missing decision has effective value={effective_value!r}"
        )
        assert decision.start is None, f"{sample_path} {decision.field} missing start must be None"
        assert decision.end is None, f"{sample_path} {decision.field} missing end must be None"
        return

    assert decision.decision in ASSIGN_DECISIONS | SUGGEST_DECISIONS, (
        f"{sample_path} {decision.field} has a range but is {decision.decision}"
    )
    assert decision.value is not None, f"{sample_path} {decision.field} has no value"
    assert clean_text[decision.start:decision.end] == decision.value, (
        f"{sample_path} {decision.field} -> "
        f'value="{decision.value}" slice="{clean_text[decision.start:decision.end]}"'
    )


def _manual_action(result, field, selected_text):
    start = result["clean_text"].index(selected_text)
    return {
        "field": field,
        "value": selected_text,
        "selected_text": selected_text,
        "start": start,
        "end": start + len(selected_text),
        "candidate_id": "",
        "segment_id": "",
        "source": "manual",
    }


@pytest.fixture
def isolated_learning_store(tmp_path, monkeypatch):
    store_path = tmp_path / "learning_store.json"
    confidence_path = tmp_path / "confidence_store.json"
    monkeypatch.setattr(learning_store, "STORE_PATH", str(store_path))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(confidence_path))
    return store_path


@pytest.fixture
def simple_order_eml(tmp_path):
    body = (
        "Order #A100\n"
        "Quantity: 5\n"
        "Price: 99.99\n"
        "Customer email: buyer@example.com\n"
    )
    return _make_eml(tmp_path / "simple.eml", body)


def test_learning_assignment_persists(simple_order_eml, isolated_learning_store):
    initial = parse_eml(simple_order_eml)
    template_id = compute_template_id(initial["clean_text"])
    quantity = next(d for d in initial["decisions"] if d.field == "quantity")
    quantity_candidate = next(c for c in initial["candidates"] if c.id == quantity.candidate_id)

    learning_store.save_assignment(template_id, "quantity", quantity.value, {
        "segment_id": quantity_candidate.segment_id,
        "start": quantity_candidate.start,
        "end": quantity_candidate.end,
        "selected_text": quantity_candidate.raw_text,
        "segment_text": quantity_candidate.segment_text,
        "left_context": quantity_candidate.left_context,
        "right_context": quantity_candidate.right_context,
    })

    records = learning_store.load_assignments(template_id, "quantity")
    assert len(records) == 1
    assert records[0]["value"] == "5"
    assert records[0]["active"] is True

    reparsed = parse_eml(simple_order_eml)
    reparsed_quantity = next(d for d in reparsed["decisions"] if d.field == "quantity")
    assert reparsed_quantity.value == "5"
    assert reparsed_quantity.decision == "assigned"
    assert reparsed["clean_text"][reparsed_quantity.start:reparsed_quantity.end] == "5"


def test_unlearning_reject_suppresses(simple_order_eml, isolated_learning_store):
    initial = parse_eml(simple_order_eml)
    template_id = compute_template_id(initial["clean_text"])
    price = next(d for d in initial["decisions"] if d.field == "price")
    price_candidate = next(c for c in initial["candidates"] if c.id == price.candidate_id)

    learning_store.save_rejection(template_id, "price", {
        "value": price.value,
        "segment_id": price_candidate.segment_id,
        "start": price_candidate.start,
        "end": price_candidate.end,
        "selected_text": price_candidate.raw_text,
        "segment_text": price_candidate.segment_text,
        "left_context": price_candidate.left_context,
        "right_context": price_candidate.right_context,
    })

    records = learning_store.load_records(template_id, field="price", record_type="reject")
    assert len(records) == 1
    assert records[0]["active"] is True

    reparsed = parse_eml(simple_order_eml)
    assert all(d.field != "price" for d in reparsed["decisions"])


def test_healing_reject_then_assign_restores(simple_order_eml, isolated_learning_store):
    initial = parse_eml(simple_order_eml)
    template_id = compute_template_id(initial["clean_text"])
    price = next(d for d in initial["decisions"] if d.field == "price")
    price_candidate = next(c for c in initial["candidates"] if c.id == price.candidate_id)
    context = _price_context(initial, price_candidate)

    learning_store.save_rejection(template_id, "price", context)
    rejected = parse_eml(simple_order_eml)
    assert all(d.field != "price" for d in rejected["decisions"])

    learning_store.save_assignment(template_id, "price", price.value, context)

    reject_records = learning_store.load_records(template_id, field="price", record_type="reject")
    assign_records = learning_store.load_records(template_id, field="price", record_type="assign")
    assert reject_records[0]["active"] is False
    assert assign_records[0]["active"] is True

    healed = parse_eml(simple_order_eml)
    healed_price = next(d for d in healed["decisions"] if d.field == "price")
    assert healed_price.value == "99.99"
    assert healed_price.decision == "assigned"
    assert healed["clean_text"][healed_price.start:healed_price.end] == "99.99"


def test_manual_assignment_bypasses_structure_gate_and_persists(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "manual-weird-order-number.eml",
        "Customer selected custom identifier: NOT-AN-ORDER\n"
        "Zip code: 90210\n"
        "Quantity: 1\n"
        "Price: $20.00\n",
    )
    initial = parse_eml(eml, update_confidence=False)

    response = apply_learning(
        "save_assignment",
        eml,
        _manual_action(initial, "order_number", "NOT-AN-ORDER"),
    )
    assigned = next(decision for decision in response["decisions"] if decision["field"] == "order_number")

    assert assigned["value"] == "NOT-AN-ORDER"
    assert assigned["decision"] == "assigned"
    assert assigned["decision_source"] == "manual_override"

    reparsed = parse_eml(eml, update_confidence=False)
    order_number = next(decision for decision in reparsed["decisions"] if decision.field == "order_number")

    assert order_number.value == "NOT-AN-ORDER"
    assert order_number.decision == "assigned"
    assert reparsed["clean_text"][order_number.start:order_number.end] == "NOT-AN-ORDER"


def test_manual_assignment_after_rejection_overrides_rejection(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "manual-after-reject.eml",
        "Order candidate: 90210\n"
        "Correct order number: 778899\n"
        "Quantity: 1\n"
        "Price: $20.00\n",
    )
    initial = parse_eml(eml, update_confidence=False)
    rejected_candidate = next(
        candidate for candidate in initial["candidates"]
        if candidate.value == "90210"
    )
    learning_store.save_rejection(initial["template_family_id"], "order_number", {
        "value": rejected_candidate.value,
        "candidate_id": rejected_candidate.id,
        "segment_id": rejected_candidate.segment_id,
        "start": rejected_candidate.start,
        "end": rejected_candidate.end,
        "selected_text": rejected_candidate.raw_text,
        "segment_text": rejected_candidate.segment_text,
        "left_context": rejected_candidate.left_context,
        "right_context": rejected_candidate.right_context,
        "extractor": rejected_candidate.extractor,
    })

    rejected = parse_eml(eml, update_confidence=False)
    assert all(decision.field != "order_number" for decision in rejected["decisions"])

    response = apply_learning(
        "save_assignment",
        eml,
        _manual_action(initial, "order_number", "778899"),
    )
    assigned = next(decision for decision in response["decisions"] if decision["field"] == "order_number")

    assert assigned["value"] == "778899"
    assert assigned["decision_source"] == "manual_override"

    reparsed = parse_eml(eml, update_confidence=False)
    order_number = next(decision for decision in reparsed["decisions"] if decision.field == "order_number")

    assert order_number.value == "778899"
    assert order_number.decision == "assigned"
    assert reparsed["clean_text"][order_number.start:order_number.end] == "778899"


def test_assignment_self_heals_matching_shipping_rejection(isolated_learning_store):
    template_id = "shipping-self-heal"
    learning_store.save_rejection(template_id, "shipping_address", {
        "value": "Old Address",
        "candidate_id": "addr_0001",
        "extractor": "address_block_with_recipient",
        "learned_signature": "address_block_with_recipient|none|body",
        "section_type": "body",
    })

    learning_store.save_assignment(template_id, "shipping_address", "Correct Address", {
        "candidate_id": "addr_0001",
        "extractor": "address_block_with_recipient",
        "learned_signature": "address_block_with_recipient|none|body",
        "section_type": "body",
    })

    reject_records = learning_store.load_records(template_id, field="shipping_address", record_type="reject")
    assign_records = learning_store.load_records(template_id, field="shipping_address", record_type="assign")

    assert reject_records[0]["active"] is False
    assert reject_records[0]["healed_by_assignment"] is True
    assert reject_records[0]["assign_count"] == 1
    assert assign_records[0]["active"] is True
    assert assign_records[0]["value"] == "Correct Address"


def test_price_assignment_only_heals_matching_rejection(isolated_learning_store):
    template_id = "price-self-heal"
    learning_store.save_rejection(template_id, "price", {
        "value": "51.00",
        "candidate_id": "price_total",
        "extractor": "number_regex",
        "learned_signature": "price|order_total|body",
        "section_type": "body",
        "nearby_label": "order_total",
    })
    learning_store.save_rejection(template_id, "price", {
        "value": "12.00",
        "candidate_id": "price_item",
        "extractor": "number_regex",
        "learned_signature": "price|item_price|body",
        "section_type": "body",
        "nearby_label": "item_price",
    })

    learning_store.save_assignment(template_id, "price", "12.00", {
        "candidate_id": "price_item",
        "extractor": "number_regex",
        "learned_signature": "price|item_price|body",
        "section_type": "body",
        "nearby_label": "item_price",
    })

    records = learning_store.load_records(template_id, field="price", record_type="reject")
    by_signature = {record["learned_signature"]: record for record in records}

    assert by_signature["price|item_price|body"]["active"] is False
    assert by_signature["price|item_price|body"]["healed_by_assignment"] is True
    assert by_signature["price|order_total|body"]["active"] is True


def test_reset_field_learning_is_field_scoped(isolated_learning_store):
    learning_store.save_assignment("template-a", "shipping_address", "Correct Address", {
        "candidate_id": "addr_0001",
        "extractor": "address_block_with_recipient",
    })
    learning_store.save_rejection("template-a", "shipping_address", {
        "candidate_id": "addr_0002",
        "extractor": "address_block_with_recipient",
    })
    learning_store.save_assignment("template-a", "price", "12.00", {
        "candidate_id": "price_item",
        "extractor": "number_regex",
    })
    confidence_store.update_streak("template-a", "shipping_address", "addr_sig", "Correct Address")
    confidence_store.update_streak("template-a", "price", "price_sig", "12.00")

    reset_result = learning_store.reset_field_learning("shipping_address")
    confidence_removed = confidence_store.reset_field_everywhere("shipping_address")
    confidence_summary = confidence_store.summarize_fields({"price", "shipping_address"})

    assert reset_result["assignments_removed"] == 1
    assert reset_result["rejections_removed"] == 1
    assert confidence_removed == 1
    assert learning_store.load_records("template-a", field="shipping_address") == []
    assert len(learning_store.load_records("template-a", field="price", record_type="assign")) == 1
    assert confidence_summary["price"]["entries"] == 1
    assert confidence_summary["shipping_address"]["entries"] == 0


def _address_candidate(value, start=100, extractor="address_block_with_recipient"):
    return Candidate(
        id="addr_0001",
        field_type="shipping_address",
        value=value,
        raw_text=value,
        start=start,
        end=start + len(value),
        segment_id="seg_address",
        extractor=extractor,
        source="shipping",
    )


def _save_shipping_line_assignment(template_id, candidate, selected_lines, buyer_name=""):
    selected_text = "\n".join(selected_lines)
    relative_start = candidate.value.index(selected_lines[0])
    selected_start = candidate.start + relative_start
    selected_end = selected_start + len(selected_text)
    learning_store.save_assignment(template_id, "shipping_address", selected_text, {
        "candidate_id": candidate.id,
        "extractor": candidate.extractor,
        "learned_signature": "address_block|shipping",
        "selected_text": selected_text,
        "start": selected_start,
        "end": selected_end,
        **build_shipping_address_line_learning(candidate, selected_start, selected_end, buyer_name),
    })


def test_shipping_line_learning_selects_street_and_city_without_country(tmp_path, isolated_learning_store):
    first = _address_candidate("Jane Buyer\n123 Maple Drive\nAustin, TX 78701\nUnited States")
    template_id = "address-line-types"
    _save_shipping_line_assignment(template_id, first, ["123 Maple Drive", "Austin, TX 78701"], "Jane Buyer")

    second = _make_eml(
        tmp_path / "address-line-second.eml",
        "Order #3002\n"
        "Shipping address\n"
        "Rachel Customer\n"
        "900 Oak Road\n"
        "Denver, CO 80202\n"
        "United States\n",
    )

    reparsed = parse_eml(second, update_confidence=False)
    address = next(decision for decision in reparsed["decisions"] if decision.field == "shipping_address")

    assert address.value == "900 Oak Road\nDenver, CO 80202"
    assert "United States" not in address.value
    assert "assigned_line_types(authoritative)" in address.provenance["signals"]


def test_shipping_line_learning_ignores_extra_company_line(tmp_path, isolated_learning_store):
    first = _address_candidate("Jane Buyer\n123 Maple Drive\nAustin, TX 78701\nUnited States")
    template_id = "address-line-types"
    _save_shipping_line_assignment(template_id, first, ["123 Maple Drive", "Austin, TX 78701"], "Jane Buyer")

    second = _make_eml(
        tmp_path / "address-line-company.eml",
        "Order #3003\n"
        "Shipping address\n"
        "Rachel Customer\n"
        "Acme Memorials LLC\n"
        "900 Oak Road\n"
        "Denver, CO 80202\n"
        "United States\n",
    )

    reparsed = parse_eml(second, update_confidence=False)
    address = next(decision for decision in reparsed["decisions"] if decision.field == "shipping_address")

    assert address.value == "900 Oak Road\nDenver, CO 80202"
    assert "Acme Memorials LLC" not in address.value
    assert "United States" not in address.value


def test_shipping_line_learning_can_include_name_and_exclude_country(tmp_path, isolated_learning_store):
    first = _address_candidate("Jane Buyer\n123 Maple Drive\nAustin, TX 78701\nUnited States")
    template_id = "address-line-types"
    _save_shipping_line_assignment(
        template_id,
        first,
        ["Jane Buyer", "123 Maple Drive", "Austin, TX 78701"],
        "Jane Buyer",
    )

    second = _make_eml(
        tmp_path / "address-line-name.eml",
        "Order #3004\n"
        "Shipping address\n"
        "Rachel Customer\n"
        "900 Oak Road\n"
        "Denver, CO 80202\n"
        "United States\n",
    )

    reparsed = parse_eml(second, update_confidence=False)
    address = next(decision for decision in reparsed["decisions"] if decision.field == "shipping_address")

    assert address.value == "Rachel Customer\n900 Oak Road\nDenver, CO 80202"
    assert "United States" not in address.value


def _price_context(result, candidate):
    segments = result["segments"]
    segment_map = result["segment_map"]
    return {
        "segment_id": candidate.segment_id,
        "start": candidate.start,
        "end": candidate.end,
        "selected_text": candidate.raw_text,
        "segment_text": candidate.segment_text,
        "left_context": candidate.left_context,
        "right_context": candidate.right_context,
        "candidate_id": candidate.id,
        "extractor": candidate.extractor,
        "learned_signature": build_price_signature(candidate, segment_map, segments),
        "price_type": classify_price_type(candidate, segments),
        "section_type": _price_section_type(candidate, segments),
        "nearby_label": _price_nearby_label(candidate, segments),
        "context_class": _price_context_class(candidate, segments),
        "relative_position": _price_relative_position(candidate, segments),
    }


def test_price_assignment_replays_current_structural_candidate_not_old_value(tmp_path, isolated_learning_store):
    first = _make_eml(
        tmp_path / "price-first.eml",
        "Order #1001\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $35.00\n"
        "Sales tax: $2.50\n"
        "Order total: $37.50\n",
    )
    second = _make_eml(
        tmp_path / "price-second.eml",
        "Order #1002\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $42.00\n"
        "Sales tax: $3.00\n"
        "Order total: $45.00\n",
    )

    initial = parse_eml(first, update_confidence=False)
    template_id = initial["template_family_id"]
    assigned_candidate = next(
        candidate for candidate in initial["candidates"]
        if candidate.value == "35.00" and "Price:" in candidate.segment_text
    )

    learning_store.save_assignment(
        template_id,
        "price",
        assigned_candidate.value,
        _price_context(initial, assigned_candidate),
    )

    reparsed = parse_eml(second, update_confidence=False)
    price = next(decision for decision in reparsed["decisions"] if decision.field == "price")

    assert price.value == "42.00"
    assert price.decision == "assigned"
    assert price.decision_source == "score"
    assert "assigned_price_type(authoritative)" in price.provenance["signals"]
    assert "35.00" not in price.value
    assert reparsed["clean_text"][price.start:price.end] == "42.00"


def test_price_type_learning_selects_current_item_prices_across_orders(tmp_path, isolated_learning_store):
    first = _make_eml(
        tmp_path / "price-type-first.eml",
        "Order #5001\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $35.00\n"
        "Shipping: $4.00\n"
        "Sales tax: $2.50\n"
        "Order total: $41.50\n",
    )
    initial = parse_eml(first, update_confidence=False)
    template_id = initial["template_family_id"]
    assigned_candidate = next(
        candidate for candidate in initial["candidates"]
        if candidate.value == "35.00" and "Price:" in candidate.segment_text
    )
    learning_store.save_assignment(
        template_id,
        "price",
        assigned_candidate.value,
        _price_context(initial, assigned_candidate),
    )

    orders = [
        ("5002", "42.00", "4.25", "3.00", "49.25"),
        ("5003", "18.50", "0.00", "1.40", "19.90"),
        ("5004", "64.00", "6.95", "5.12", "76.07"),
        ("5005", "27.75", "3.50", "2.08", "33.33"),
        ("5006", "91.20", "8.00", "7.44", "106.64"),
    ]
    for order_number, item_price, shipping, tax, total in orders:
        eml = _make_eml(
            tmp_path / f"price-type-{order_number}.eml",
            f"Order #{order_number}\n"
            "Product: Memorial Ornament\n"
            "Quantity: 1\n"
            f"Price: ${item_price}\n"
            f"Shipping: ${shipping}\n"
            f"Sales tax: ${tax}\n"
            f"Order total: ${total}\n",
        )
        reparsed = parse_eml(eml, update_confidence=False)
        price = next(decision for decision in reparsed["decisions"] if decision.field == "price")

        assert price.value == item_price
        assert price.value != total
        assert price.value != "35.00"
        assert "assigned_price_type(authoritative)" in price.provenance["signals"]
        assert reparsed["clean_text"][price.start:price.end] == item_price


def test_price_rejection_penalizes_matching_structure(tmp_path, isolated_learning_store):
    first = _make_eml(
        tmp_path / "price-reject-first.eml",
        "Order #2001\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $35.00\n"
        "Order total: $42.00\n",
    )
    second = _make_eml(
        tmp_path / "price-reject-second.eml",
        "Order #2002\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $44.00\n"
        "Order total: $51.00\n",
    )

    initial = parse_eml(first, update_confidence=False)
    template_id = initial["template_family_id"]
    rejected_candidate = next(
        candidate for candidate in initial["candidates"]
        if candidate.value == "42.00" and "Order total" in candidate.segment_text
    )

    learning_store.save_rejection(template_id, "price", {
        "value": rejected_candidate.value,
        **_price_context(initial, rejected_candidate),
    })

    reparsed = parse_eml(second, update_confidence=False)
    fresh_numbers = extract_numbers(reparsed["segments"])
    fresh_quantity = score_quantity(fresh_numbers, reparsed["segments"])
    fresh_prices = score_price(fresh_numbers, reparsed["segments"], fresh_quantity)
    fresh_prices = _apply_price_rejections(template_id, fresh_prices, reparsed["segments"], reparsed["segment_map"])
    rejected_next = next(
        candidate for candidate in fresh_prices
        if candidate.value == "51.00" and "Order total" in candidate.segment_text
    )
    price = next(decision for decision in reparsed["decisions"] if decision.field == "price")

    assert "rejected_price_structure(-60)" in rejected_next.penalties
    assert price.value == "44.00"


def test_multiline_shipping_assignment_replays_selected_text_exactly(tmp_path, isolated_learning_store):
    body = (
        "Order #4035149940\n"
        "Shipping address\n"
        "Rachel Loftus-Jungwirth\n"
        "16684 Markley Lake Dr SE\n"
        "PRIOR LAKE , MN 55372-1998\n"
        "United States\n"
        "Purchase Shipping Label\n"
        "Quantity: 1\n"
        "Price: $64.00\n"
        "Customer email: rachel.m.loftus@gmail.com\n"
    )
    eml_path = _make_eml(tmp_path / "etsy-address.eml", body, subject="Order #4035149940")
    initial = parse_eml(eml_path)
    template_id = initial["template_family_id"]
    selected_text = "16684 Markley Lake Dr SE\nPRIOR LAKE , MN 55372-1998\nUnited States"
    start = initial["clean_text"].index(selected_text)
    end = start + len(selected_text)

    learning_store.save_assignment(template_id, "shipping_address", selected_text, {
        "segment_id": "",
        "start": start,
        "end": end,
        "selected_text": selected_text,
        "segment_text": selected_text,
        "left_context": "",
        "right_context": "",
    })

    records = learning_store.load_assignments(template_id, "shipping_address")
    assert records[0]["value"] == "16684 Markley Lake Dr SE PRIOR LAKE , MN 55372-1998 United States"
    assert records[0]["selected_text"] == selected_text

    reparsed = parse_eml(eml_path, update_confidence=False)
    address = next(d for d in reparsed["decisions"] if d.field == "shipping_address")

    assert address.value == selected_text
    assert address.start == start
    assert address.end == end
    assert reparsed["clean_text"][address.start:address.end] == selected_text
    assert "Rachel Loftus-Jungwirth" not in address.value


@pytest.mark.parametrize(
    "sample_path",
    [
        "tests/samples/2353.eml",
        "tests/samples/4024391570.eml",
        "tests/samples/You made a sale on Etsy - Ship by Apr 17 - [$37.89, Order #4025790946].eml",
    ],
)
def test_integrity_value_equals_slice(sample_path, isolated_learning_store):
    result = parse_eml(sample_path)

    for decision in result["decisions"]:
        _assert_decision_state_contract(decision, result["clean_text"], sample_path)
