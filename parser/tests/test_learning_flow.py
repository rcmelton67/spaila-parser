from pathlib import Path
import json

import pytest

from parser.pipeline import parse_eml
from parser.pipeline import (
    _apply_structural_trust,
    _apply_price_rejections,
    build_buyer_name_confidence_signature,
    build_buyer_email_confidence_signature,
    build_order_number_confidence_signature,
    build_order_date_confidence_signature,
    build_quantity_confidence_signature,
    build_ship_by_confidence_signature,
    build_item_price_confidence_signature,
    build_price_signature,
    build_shipping_address_confidence_signature,
    build_shipping_address_line_learning,
    classify_price_type,
    is_safe_item_price_candidate,
    is_safe_buyer_email_candidate,
    is_safe_quantity_candidate,
    is_safe_order_date_candidate,
    is_safe_ship_by_candidate,
    _price_context_class,
    _price_nearby_label,
    _price_relative_position,
    _price_section_type,
)
from parser.models import Candidate
from parser.extract import extract_numbers
from parser.score import score_price, score_quantity
from parser.anchors.match import apply_anchor_scoring
from parser.decide import decide_buyer_name
from parser.ui_bridge import apply_learning
from parser.replay.fingerprint import compute_template_id, compute_template_family_id
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
    rejected_order = next(decision for decision in rejected["decisions"] if decision.field == "order_number")
    assert rejected_order.value == "778899"

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

    reject_records = learning_store.load_records(initial["template_family_id"], field="order_number", record_type="reject")
    assert any(record["value"] == "90210" and record["active"] for record in reject_records)


def test_zip_order_number_assignment_is_quarantined(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "zip-poison.eml",
        "New order: #1928\n"
        "Order summary\n"
        "Order #1928 (December 1, 2025)\n"
        "Shipping address\n"
        "Brenda Espinosa\n"
        "1220 7th St NE\n"
        "Rochester, MN 55906\n",
        subject="New order: #1928",
    )
    initial = parse_eml(eml, update_confidence=False)
    template_id = initial["template_family_id"]
    zip_candidate = next(c for c in initial["candidates"] if c.value == "55906")

    learning_store.save_assignment(template_id, "order_number", "55906", {
        "segment_id": zip_candidate.segment_id,
        "start": zip_candidate.start,
        "end": zip_candidate.end,
        "selected_text": zip_candidate.raw_text,
        "segment_text": zip_candidate.segment_text,
        "left_context": zip_candidate.left_context,
        "right_context": zip_candidate.right_context,
        "candidate_id": zip_candidate.id,
        "extractor": zip_candidate.extractor,
        "learned_signature": "number_regex|none|body",
    })

    records = learning_store.load_records(template_id, field="order_number", record_type="assign")
    reparsed = parse_eml(eml, update_confidence=False)
    order_number = next(d for d in reparsed["decisions"] if d.field == "order_number")

    assert records[0]["active"] is False
    assert learning_store.load_assignments(template_id, "order_number") == []
    assert order_number.value == "1928"


def test_legacy_zip_assignment_cannot_replay_after_safety_gate(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "legacy-zip-poison.eml",
        "New order: #1933\n"
        "Order summary\n"
        "Order #1933 (December 5, 2025)\n"
        "Shipping address\n"
        "Sarah Brattain\n"
        "311 Surf St\n"
        "Lake Dallas, TX 75065\n",
        subject="New order: #1933",
    )
    initial = parse_eml(eml, update_confidence=False)
    template_id = initial["template_family_id"]
    store = {
        template_id: [{
            "field": "order_number",
            "value": "75065",
            "template_id": template_id,
            "segment_id": "seg_0007",
            "start": initial["clean_text"].index("75065"),
            "end": initial["clean_text"].index("75065") + 5,
            "selected_text": "75065",
            "segment_text": "Lake Dallas, TX 75065",
            "left_context": "allas, TX ",
            "right_context": "",
            "candidate_id": "legacy_zip",
            "extractor": "number_regex",
            "learned_signature": "number_regex|none|body",
            "type": "assign",
            "active": True,
        }]
    }
    isolated_learning_store.write_text(json.dumps(store), encoding="utf-8")

    reparsed = parse_eml(eml, update_confidence=False)
    order_number = next(d for d in reparsed["decisions"] if d.field == "order_number")

    assert order_number.value == "1933"


def test_order_number_confidence_signature_uses_safe_structure(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "safe-order-signature.eml",
        "New order: #1999\n"
        "Order summary\n"
        "Order #1999 (December 24, 2025)\n"
        "Shipping address\n"
        "Charles Asbornsen\n"
        "109 Teal Court\n"
        "Sneads Ferry, NC 28460\n",
        subject="New order: #1999",
    )
    result = parse_eml(eml, update_confidence=False)
    segment_map = {segment.id: segment for segment in result["segments"]}
    candidate = next(c for c in result["candidates"] if c.value == "1999" and "New order" in c.segment_text)

    signature = build_order_number_confidence_signature(candidate, segment_map)

    assert signature == "number_regex|explicit_order_label|order_header|order_header_number|early_header"


def test_order_number_confidence_signature_keeps_zip_generic_quarantinable(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "zip-order-signature.eml",
        "New order: #1999\n"
        "Shipping address\n"
        "Charles Asbornsen\n"
        "109 Teal Court\n"
        "Sneads Ferry, NC 28460\n",
        subject="New order: #1999",
    )
    result = parse_eml(eml, update_confidence=False)
    segment_map = {segment.id: segment for segment in result["segments"]}
    candidate = next(c for c in result["candidates"] if c.value == "28460")

    signature = build_order_number_confidence_signature(candidate, segment_map)

    assert signature == "number_regex|none|body"


def test_safe_order_number_confidence_record_uses_structural_signature(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "safe-order-confidence-record.eml",
        "New order: #1999\n"
        "Order summary\n"
        "Order #1999 (December 24, 2025)\n"
        "Shipping address\n"
        "Charles Asbornsen\n"
        "109 Teal Court\n"
        "Sneads Ferry, NC 28460\n",
        subject="New order: #1999",
    )

    result = parse_eml(eml, update_confidence=True)
    order_number = next(d for d in result["decisions"] if d.field == "order_number")
    confidence = confidence_store._load()

    assert order_number.value == "1999"
    assert any(
        record["field"] == "order_number"
        and record["extraction_signature"] == "number_regex|explicit_order_label|order_header|order_header_number|early_header"
        for record in confidence.values()
    )
    assert not any(
        record["field"] == "order_number"
        and record["extraction_signature"] == "number_regex|none|body"
        for record in confidence.values()
    )


def test_order_number_structural_confidence_matures_into_trust(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "safe-order-confidence-hold.eml",
        "New order: #1999\n"
        "Order summary\n"
        "Order #1999 (December 24, 2025)\n",
        subject="New order: #1999",
    )

    last = None
    for _ in range(4):
        last = parse_eml(eml, update_confidence=True)

    order_number = next(d for d in last["decisions"] if d.field == "order_number")
    confidence = confidence_store._load()
    structural_records = [
        record for record in confidence.values()
        if record["field"] == "order_number"
        and record["extraction_signature"] == "number_regex|explicit_order_label|order_header|order_header_number|early_header"
    ]

    assert structural_records
    assert max(record["streak_count"] for record in structural_records) >= 4
    assert order_number.value == "1999"
    assert order_number.decision == "assigned"
    assert order_number.decision_source == "structural_maturity_promotion"
    assert order_number.provenance["maturity_progress"] >= 4
    assert order_number.provenance["promotion_threshold"] == 4
    assert order_number.provenance["why_promoted"] == "safe_numeric_structural_maturity"

    trust_records = learning_store.load_structural_trust("order_number", last["template_family_id"])
    assert any(
        record["trust_state"] == "promoted"
        and record["role"] == "order_header_number"
        for record in trust_records
    )


def test_safe_order_number_maturation_enables_future_structural_replay(tmp_path, isolated_learning_store):
    bodies = [
        "New order: #1989\nOrder summary\nOrder #1989 (December 18, 2025)\nQuantity: 1\nTotal: $39.00\n",
        "New order: #1994\nOrder summary\nOrder #1994 (December 22, 2025)\nQuantity: 1\nTotal: $39.00\n",
        "New order: #1999\nOrder summary\nOrder #1999 (December 24, 2025)\nQuantity: 1\nTotal: $39.00\n",
        "New order: #2006\nOrder summary\nOrder #2006 (December 30, 2025)\nQuantity: 1\nTotal: $39.00\n",
    ]
    for i, body in enumerate(bodies, start=1):
        result = parse_eml(_make_eml(tmp_path / f"mature_{i}.eml", body), update_confidence=True)

    mature_order = next(d for d in result["decisions"] if d.field == "order_number")
    assert mature_order.value == "2006"
    assert mature_order.decision_source == "structural_maturity_promotion"

    followup = parse_eml(
        _make_eml(
            tmp_path / "mature_followup.eml",
            "New order: #2010\nOrder summary\nOrder #2010 (January 2, 2026)\nQuantity: 1\nTotal: $39.00\n",
        ),
        update_confidence=True,
    )
    followup_order = next(d for d in followup["decisions"] if d.field == "order_number")
    assert followup_order.value == "2010"
    assert followup_order.decision == "assigned"
    assert followup_order.decision_source == "structural_trust_replay"
    assert followup_order.provenance["structural_replay_used"] is True


def test_shopify_like_four_digit_order_matures_without_zip_contamination(tmp_path, isolated_learning_store):
    for value in ("1234", "1235", "1236", "1237"):
        result = parse_eml(
            _make_eml(
                tmp_path / f"shopify_{value}.eml",
                f"Order {value}\nShip to\nJane Buyer\n10 Main St\nRochester, MN 55906\nTotal: $48.00\n",
            ),
            update_confidence=True,
        )

    order = next(d for d in result["decisions"] if d.field == "order_number")
    assert order.value == "1237"
    assert order.decision == "assigned"
    assert order.decision_source == "structural_maturity_promotion"
    assert "explicit_order_label" in order.provenance["confidence_signature"]
    assert "order_header_number" in order.provenance["confidence_signature"]


def test_zip_candidates_do_not_mature_as_order_number(tmp_path, isolated_learning_store):
    for i in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"zip_{i}.eml",
                "Ship to\nJane Buyer\n10 Main St\nRochester, MN 55906\nTotal: $48.00\n",
            ),
            update_confidence=True,
        )
        order = next((d for d in result["decisions"] if d.field == "order_number"), None)
        if order is not None:
            assert order.decision != "assigned"

    assert not learning_store.load_structural_trust("order_number")


def test_generic_body_numbers_do_not_mature_as_order_number(tmp_path, isolated_learning_store):
    for value in ("7001", "7002", "7003", "7004"):
        result = parse_eml(
            _make_eml(
                tmp_path / f"generic_{value}.eml",
                f"Reference {value}\nQuantity: 1\nTotal: $12.00\n",
            ),
            update_confidence=True,
        )
        order = next((d for d in result["decisions"] if d.field == "order_number"), None)
        if order is not None:
            assert order.decision != "assigned"

    assert not learning_store.load_structural_trust("order_number")


def test_order_number_structural_replay_assigns_current_value_after_exact_replay_fails(tmp_path, isolated_learning_store):
    first = _make_eml(
        tmp_path / "first-structural-replay.eml",
        "New order: #2006\n"
        "Order summary\n"
        "Order #2006 (December 30, 2025)\n"
        "Shipping address\n"
        "Katy Kerns\n"
        "22 Main St\n"
        "Lexington, KY 40502\n",
        subject="New order: #2006",
    )
    initial = parse_eml(first, update_confidence=False)
    template_id = initial["template_family_id"]
    order_candidate = next(c for c in initial["candidates"] if c.value == "2006" and "New order" in c.segment_text)
    learning_store.save_assignment(template_id, "order_number", "2006", {
        "segment_id": order_candidate.segment_id,
        "start": order_candidate.start,
        "end": order_candidate.end,
        "selected_text": order_candidate.raw_text,
        "segment_text": order_candidate.segment_text,
        "left_context": order_candidate.left_context,
        "right_context": order_candidate.right_context,
        "candidate_id": order_candidate.id,
        "extractor": order_candidate.extractor,
        "learned_signature": "number_regex|none|body",
    })

    second = _make_eml(
        tmp_path / "second-structural-replay.eml",
        "New order: #1989\n"
        "Order summary\n"
        "Order #1989 (December 18, 2025)\n"
        "Shipping address\n"
        "Katharina Speltz\n"
        "4304 Lake Carlton Dr\n"
        "Lutz, FL 33558\n",
        subject="New order: #1989",
    )
    probe = parse_eml(second, update_confidence=False)
    segment_map = {segment.id: segment for segment in probe["segments"]}
    current_candidate = next(c for c in probe["candidates"] if c.value == "1989" and "New order" in c.segment_text)
    confidence_signature = build_order_number_confidence_signature(current_candidate, segment_map)
    confidence_store._save({
        f"{template_id}:order_number:{confidence_signature}": {
            "field": "order_number",
            "template_id": template_id,
            "extraction_signature": confidence_signature,
            "source": "",
            "last_value": "1989",
            "streak_count": 4,
        }
    })

    reparsed = parse_eml(second, update_confidence=False)
    order_number = next(d for d in reparsed["decisions"] if d.field == "order_number")

    assert order_number.value == "1989"
    assert order_number.decision == "assigned"
    assert order_number.decision_source == "structural_trust_replay"
    assert order_number.provenance["structural_replay_used"] is True
    assert order_number.provenance["confidence_signature"] == confidence_signature


def test_generic_signature_can_assist_but_not_anchor_lock(isolated_learning_store):
    template_id = "generic-hard-lock"
    learning_store.save_record({
        "field": "buyer_name",
        "value": "Jane Buyer",
        "template_id": template_id,
        "segment_id": "seg_0001",
        "start": 0,
        "end": 10,
        "selected_text": "Jane Buyer",
        "segment_text": "Jane Buyer",
        "left_context": "",
        "right_context": "",
        "candidate_id": "name_0001",
        "extractor": "address_label_name",
        "learned_signature": "address_label_name|none|body",
        "type": "assign",
        "active": True,
    })
    candidate = Candidate(
        id="name_0001",
        field_type="buyer_name",
        value="Jane Buyer",
        raw_text="Jane Buyer",
        start=0,
        end=10,
        segment_id="seg_0001",
        extractor="address_label_name",
        score=0,
        segment_text="Jane Buyer",
        left_context="",
        right_context="",
    )

    scored = apply_anchor_scoring(template_id, "buyer_name", [candidate])
    decision = decide_buyer_name(scored)

    assert scored[0].anchor_match == 0.0
    assert "assigned_value(+2.5)" in scored[0].signals
    assert not any(signal.startswith("anchor_override") for signal in scored[0].signals)
    assert decision is not None
    assert decision.decision == "suggested"


def test_reject_then_assign_writes_negative_and_positive_structural_rules(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "self-heal-order-number.eml",
        "New order: #1935\n"
        "Order summary\n"
        "Order #1935 (December 7, 2025)\n"
        "Shipping address\n"
        "Ryan Baird\n"
        "5420 Buchanan Loop Road\n"
        "Texarkana, TX 75501\n",
        subject="New order: #1935",
    )
    initial = parse_eml(eml, update_confidence=False)
    zip_candidate = next(c for c in initial["candidates"] if c.value == "75501")
    order_candidate = next(c for c in initial["candidates"] if c.value == "1935" and "New order" in c.segment_text)

    apply_learning("save_rejection", eml, {
        "field": "order_number",
        "value": zip_candidate.value,
        "candidate_id": zip_candidate.id,
        "segment_id": zip_candidate.segment_id,
    })
    apply_learning("save_assignment", eml, {
        "field": "order_number",
        "value": order_candidate.value,
        "candidate_id": order_candidate.id,
        "segment_id": order_candidate.segment_id,
    })

    rules = learning_store.load_structural_rules(field="order_number")
    negatives = [rule for rule in rules if rule["polarity"] == "negative"]
    positives = [rule for rule in rules if rule["polarity"] == "positive"]

    assert any(rule["role"] in {"postal_code", "city_state_zip_line"} for rule in negatives)
    assert any(rule["role"] == "order_header_number" for rule in positives)


def test_corrected_order_header_rule_applies_across_families(tmp_path, isolated_learning_store):
    first = _make_eml(
        tmp_path / "first-family.eml",
        "New order: #1933\n"
        "Shipping address\n"
        "Sarah Brattain\n"
        "311 Surf St\n"
        "Lake Dallas, TX 75065\n",
    )
    initial = parse_eml(first, update_confidence=False)
    order_candidate = next(c for c in initial["candidates"] if c.value == "1933")
    apply_learning("save_assignment", first, {
        "field": "order_number",
        "value": order_candidate.value,
        "candidate_id": order_candidate.id,
        "segment_id": order_candidate.segment_id,
    })

    second = _make_eml(
        tmp_path / "second-family.eml",
        "Invoice 2468\n"
        "Ship to\n"
        "Jane Buyer\n"
        "123 Oak Road\n"
        "Austin, TX 78701\n",
    )
    reparsed = parse_eml(second, update_confidence=False)
    order_number = next(d for d in reparsed["decisions"] if d.field == "order_number")

    assert order_number.value == "2468"


def test_structural_trust_promotes_corrected_structure(isolated_learning_store):
    template_id = "trust-promote"
    learning_store.save_assignment(template_id, "buyer_email", "buyer@example.com", {
        "value": "buyer@example.com",
        "segment_text": "Customer email: buyer@example.com",
        "left_context": "Customer email: ",
        "right_context": "",
        "extractor": "email_regex",
        "learned_signature": "email_regex|e_mail|buyer",
    })
    trusted = Candidate(
        id="email_0001",
        field_type="buyer_email",
        value="next@example.com",
        raw_text="next@example.com",
        start=0,
        end=16,
        segment_id="seg_0001",
        extractor="email_regex",
        score=1,
        segment_text="Customer email: next@example.com",
        left_context="Customer email: ",
        right_context="",
    )
    neutral = Candidate(
        id="email_0002",
        field_type="buyer_email",
        value="other@example.com",
        raw_text="other@example.com",
        start=30,
        end=47,
        segment_id="seg_0002",
        extractor="email_regex",
        score=5,
        segment_text="Footer contact: other@example.com",
        left_context="Footer contact: ",
        right_context="",
    )

    scored = _apply_structural_trust([trusted, neutral], "buyer_email", template_id)

    assert scored[0].score > scored[1].score
    assert any(signal.startswith("structural_trust_promoted") for signal in scored[0].signals)


def test_structural_trust_demotes_and_quarantines_repeated_wrong_structure(isolated_learning_store):
    template_id = "trust-quarantine"
    context = {
        "value": "Purchase Shipping Label",
        "segment_text": "Purchase Shipping Label",
        "extractor": "address_label_name",
        "learned_signature": "address_label_name|none|body",
    }
    for _ in range(3):
        learning_store.save_rejection(template_id, "buyer_name", context)

    candidate = Candidate(
        id="name_0001",
        field_type="buyer_name",
        value="Purchase Shipping Label",
        raw_text="Purchase Shipping Label",
        start=0,
        end=23,
        segment_id="seg_0001",
        extractor="address_label_name",
        score=10,
        segment_text="Purchase Shipping Label",
        left_context="",
        right_context="",
    )

    scored = _apply_structural_trust([candidate], "buyer_name", template_id)

    assert scored[0].score == -999
    assert any("structural_trust_quarantine" in penalty for penalty in scored[0].penalties)


def test_structural_trust_is_field_scoped_and_reversible(isolated_learning_store):
    template_id = "trust-reversible"
    context = {
        "value": "5",
        "segment_text": "Order candidate: 5",
        "left_context": "Order candidate: ",
        "extractor": "number_regex",
        "learned_signature": "number_regex|none|body",
    }
    learning_store.save_rejection(template_id, "order_number", context)
    quantity_context = {
        **context,
        "segment_text": "Quantity: 5",
        "left_context": "Quantity: ",
        "learned_signature": "number_regex|quantity|qty_label",
    }
    learning_store.save_assignment(template_id, "quantity", "5", quantity_context)

    order_candidate = Candidate(
        id="num_0001",
        field_type="order_number",
        value="5",
        raw_text="5",
        start=0,
        end=1,
        segment_id="seg_0001",
        extractor="number_regex",
        score=10,
        segment_text="Order candidate: 5",
        left_context="Order candidate: ",
        right_context="",
    )
    quantity_candidate = Candidate(
        id="qty_0001",
        field_type="quantity",
        value="5",
        raw_text="5",
        start=0,
        end=1,
        segment_id="seg_0001",
        extractor="number_regex",
        score=1,
        segment_text="Quantity: 5",
        left_context="Quantity: ",
        right_context="",
    )

    order_scored = _apply_structural_trust([order_candidate], "order_number", template_id)[0]
    quantity_scored = _apply_structural_trust([quantity_candidate], "quantity", template_id)[0]

    assert order_scored.score <= 10
    assert quantity_scored.score > 1

    for _ in range(3):
        learning_store.save_assignment(template_id, "order_number", "90210", {
            **context,
            "segment_text": "Order #90210",
            "left_context": "Order #",
            "learned_signature": "number_regex|order|order",
        })

    recovered = Candidate(
        id="num_0002",
        field_type="order_number",
        value="90210",
        raw_text="90210",
        start=0,
        end=5,
        segment_id="seg_0001",
        extractor="number_regex",
        score=1,
        segment_text="Order #90210",
        left_context="Order #",
        right_context="",
    )
    recovered_scored = _apply_structural_trust([recovered], "order_number", template_id)[0]

    assert recovered_scored.score > 1
    assert any(signal.startswith("structural_trust_promoted") for signal in recovered_scored.signals)


def test_woo_like_orders_share_family_despite_order_specific_values():
    first = (
        "Melton Memorials\n"
        "New order: #1933\n"
        "Order summary\n"
        "Order #1933 (December 5, 2025)\n"
        "Custom Pet Stone $54.00\n"
        "Billing address\n"
        "Sarah Brattain\n"
        "311 Surf St\n"
        "Lake Dallas, TX 75065\n"
        "Shipping address\n"
        "Sarah Brattain\n"
        "311 Surf St\n"
        "Lake Dallas, TX 75065\n"
    )
    second = (
        "Melton Memorials\n"
        "New order: #1959\n"
        "Order summary\n"
        "Order #1959 (December 15, 2025)\n"
        "Memorial size: 12x8 $74.00\n"
        "Billing address\n"
        "Julie Merring\n"
        "4322 Murfield Dr E\n"
        "Bradenton, FL 34203\n"
        "Shipping address\n"
        "Julie Merring\n"
        "4322 Murfield Dr E\n"
        "Bradenton, FL 34203\n"
    )

    assert compute_template_family_id(first) == compute_template_family_id(second)


def test_buyer_name_confidence_signature_uses_recipient_line_structure(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "buyer-name-signature.eml",
        "Order #8001\n"
        "Shipping address\n"
        "Jane Buyer\n"
        "123 Maple Drive\n"
        "Austin, TX 78701\n",
    )
    result = parse_eml(eml, update_confidence=False)
    candidate = next(c for c in result["candidates"] if c.field_type == "buyer_name" and c.value == "Jane Buyer")
    peers = [c for c in result["candidates"] if c.field_type == "buyer_name"]

    signature = build_buyer_name_confidence_signature(candidate, result["segment_map"], result["segments"], peers)

    assert signature == "address_block_first_line|shipping|shipping_recipient_name|shipping_address_label|first_line_after_label|person_name|raw_variant|mid_body"


def test_buyer_name_shipping_recipient_matures_and_replays_current_value(tmp_path, isolated_learning_store):
    names = ("Jane Buyer", "Rachel Customer", "Morgan Lane", "Taylor Stone")
    last = None
    for index, name in enumerate(names, start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"buyer-name-mature-{index}.eml",
                f"Order #{8100 + index}\n"
                "Shipping address\n"
                f"{name}\n"
                f"{100 + index} Oak Street\n"
                "Austin, TX 78701\n",
            ),
            update_confidence=True,
        )

    buyer = next(d for d in last["decisions"] if d.field == "buyer_name")
    assert buyer.value == "Taylor Stone"
    assert buyer.decision == "assigned"
    assert buyer.decision_source == "buyer_name_structural_maturity_promotion"
    assert buyer.provenance["why_promoted"] == "safe_buyer_name_recipient_line_maturity"

    followup = parse_eml(
        _make_eml(
            tmp_path / "buyer-name-followup.eml",
            "Order #8105\n"
            "Shipping address\n"
            "Avery Current\n"
            "205 Oak Street\n"
            "Austin, TX 78701\n",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "buyer_name")
    assert replayed.value == "Avery Current"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "buyer_name_structural_trust_replay"
    assert replayed.provenance["buyer_name_structural_replay_used"] is True


def test_buyer_name_billing_suppressed_when_shipping_exists(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"buyer-name-billing-suppressed-{index}.eml",
                f"Order #{8200 + index}\n"
                "Billing address\n"
                "Billing Person\n"
                "1 Billing Road\n"
                "Billingtown, TX 75001\n"
                "Shipping address\n"
                f"Ship Person {index}\n"
                "100 Shipping Lane\n"
                "Shipcity, MN 55906\n",
            ),
            update_confidence=True,
        )
    buyer = next(d for d in result["decisions"] if d.field == "buyer_name")
    assert buyer.value == "Ship Person"
    assert not any(
        record["role"] == "billing_contact_name"
        for record in learning_store.load_structural_trust("buyer_name")
    )


def test_buyer_name_billing_fallback_can_mature_without_shipping(tmp_path, isolated_learning_store):
    for index, name in enumerate(("Billing One", "Billing Two", "Billing Three", "Billing Four"), start=1):
        result = parse_eml(
            _make_eml(
                tmp_path / f"buyer-name-billing-fallback-{index}.eml",
                f"Order #{8300 + index}\n"
                "Billing address\n"
                f"{name}\n"
                "1 Billing Road\n"
                "Billingtown, TX 75001\n",
            ),
            update_confidence=True,
        )
    buyer = next(d for d in result["decisions"] if d.field == "buyer_name")
    assert buyer.value == "Billing Four"
    assert buyer.decision == "assigned"
    assert buyer.decision_source == "buyer_name_structural_maturity_promotion"
    assert buyer.provenance["recipient_role"] == "billing_contact_name"


def test_buyer_name_blocks_store_action_and_product_like_lines(tmp_path, isolated_learning_store):
    bodies = [
        "Order #8401\nShipping address\nPurchase Shipping Label\n123 Maple Drive\nAustin, TX 78701\n",
        "Order #8402\nShipping address\nMelton Memorials LLC\n123 Maple Drive\nAustin, TX 78701\n",
        "Order #8403\nShipping address\nCustom Memorial Ornament\n123 Maple Drive\nAustin, TX 78701\n",
    ]
    for index in range(4):
        for body_index, body in enumerate(bodies):
            result = parse_eml(
                _make_eml(tmp_path / f"buyer-name-unsafe-{index}-{body_index}.eml", body),
                update_confidence=True,
            )
            buyer = next((d for d in result["decisions"] if d.field == "buyer_name"), None)
            if buyer is not None:
                assert buyer.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("buyer_name")
        if record["trust_state"] == "promoted"
    ]


def test_buyer_name_business_recipient_requires_opt_in(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "buyer-business-recipient.eml",
        "Order #8501\n"
        "Shipping address\n"
        "Granite Buyers LLC\n"
        "123 Maple Drive\n"
        "Austin, TX 78701\n",
    )
    result = parse_eml(eml, update_confidence=False)
    candidate = next(c for c in result["candidates"] if c.field_type == "buyer_name")
    peers = [c for c in result["candidates"] if c.field_type == "buyer_name"]

    unsafe_sig = build_buyer_name_confidence_signature(candidate, result["segment_map"], result["segments"], peers)
    safe_sig = build_buyer_name_confidence_signature(candidate, result["segment_map"], result["segments"], peers, explicit_acceptance=True)

    assert unsafe_sig == "address_block_first_line|none|body"
    assert "business_recipient" in safe_sig


def test_buyer_name_normalized_variant_does_not_bypass_source_safety(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "buyer-name-normalized.eml",
        "Order #8601\n"
        "Billing address\n"
        "BILLING PERSON\n"
        "1 Billing Road\n"
        "Billingtown, TX 75001\n"
        "Shipping address\n"
        "SHIPPING PERSON\n"
        "100 Shipping Lane\n"
        "Shipcity, MN 55906\n",
    )
    result = parse_eml(eml, update_confidence=False)
    peers = [c for c in result["candidates"] if c.field_type == "buyer_name"]
    billing_variant = next(c for c in peers if c.value == "Billing Person")

    signature = build_buyer_name_confidence_signature(billing_variant, result["segment_map"], result["segments"], peers)

    assert signature == "normalized_variant|none|body"


def test_quantity_confidence_signature_uses_safe_line_item_structure(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "quantity-signature.eml",
        "Order #8701\n"
        "Product: Memorial Ornament\n"
        "Quantity: 3\n"
        "Price: $35.00\n",
    )
    result = parse_eml(eml, update_confidence=False)
    candidate = next(
        c for c in result["candidates"]
        if c.field_type == "number" and c.value == "3" and "Quantity" in c.segment_text
    )

    signature = build_quantity_confidence_signature(
        candidate,
        result["segment_map"],
        result["segments"],
        result["clean_text"],
    )

    assert is_safe_quantity_candidate(candidate, result["segments"], result["segment_map"])
    assert signature.startswith("number_regex|line_item_quantity|explicit_quantity_label|")
    assert "|near_product+near_price|" in signature
    assert signature.endswith("|line_item|body")


def test_quantity_repeated_line_item_matures_and_replays_current_value(tmp_path, isolated_learning_store):
    last = None
    for index, qty in enumerate(("1", "2", "3", "4"), start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"quantity-mature-{index}.eml",
                f"Order #{8700 + index}\n"
                "Product: Memorial Ornament\n"
                f"Quantity: {qty}\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )

    quantity = next(d for d in last["decisions"] if d.field == "quantity")
    assert quantity.value == "4"
    assert quantity.decision == "assigned"
    assert quantity.decision_source == "quantity_structural_maturity_promotion"
    assert quantity.provenance["why_promoted"] == "safe_quantity_structural_maturity"

    followup = parse_eml(
        _make_eml(
            tmp_path / "quantity-followup.eml",
            "Order #8705\n"
            "Product: Memorial Ornament\n"
            "Quantity: 7\n"
            "Price: $35.00\n",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "quantity")
    assert replayed.value == "7"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "quantity_structural_trust_replay"
    assert replayed.provenance["quantity_structural_replay_used"] is True


def test_stale_strict_quantity_assignment_falls_back_to_safe_scored_candidate(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "quantity-stale-assignment.eml",
        "Order #8711\n"
        "Product: Memorial Ornament\n"
        "Quantity: 3\n"
        "Price: $35.00\n",
    )
    initial = parse_eml(eml, update_confidence=False)
    template_family_id = compute_template_family_id(initial["clean_text"])
    learning_store.save_record({
        "field": "quantity",
        "value": "1",
        "template_id": template_family_id,
        "source": "",
        "segment_text": "Order summary",
        "left_context": "Subtotal",
        "right_context": "Shipping",
        "candidate_id": "stale_quantity_0001",
        "extractor": "number_regex",
        "learned_signature": "number_regex|none|order_summary",
        "type": "assign",
        "active": True,
    })

    reparsed = parse_eml(eml, update_confidence=False)
    quantity = next(d for d in reparsed["decisions"] if d.field == "quantity")

    assert quantity.value == "3"
    assert quantity.decision in (ASSIGN_DECISIONS | SUGGEST_DECISIONS)


def test_quantity_suppresses_sku_zip_price_and_order_number_contexts(tmp_path, isolated_learning_store):
    bodies = [
        "Order #8801\nProduct ID: 12345\nPrice: $35.00\n",
        "Order #8802\nShipping address\nJane Buyer\n123 Maple Drive\nAustin, TX 78701\n",
        "Order #8803\nOrder total: $42.00\n",
        "Order #8804\nNew order: #1933\n",
    ]
    for index in range(4):
        for body_index, body in enumerate(bodies):
            result = parse_eml(
                _make_eml(tmp_path / f"quantity-unsafe-{index}-{body_index}.eml", body),
                update_confidence=True,
            )
            quantity = next((d for d in result["decisions"] if d.field == "quantity"), None)
            if quantity is not None:
                assert quantity.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("quantity")
        if record["trust_state"] == "promoted"
    ]


def test_quantity_order_header_item_count_can_mature_under_control(tmp_path, isolated_learning_store):
    last = None
    for index, qty in enumerate(("1", "2", "3", "4"), start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"quantity-header-{index}.eml",
                f"New order for {qty} item\n"
                f"Reference QTY-{index}\n"
                "Total: $35.00\n",
            ),
            update_confidence=True,
        )

    quantity = next(d for d in last["decisions"] if d.field == "quantity")
    assert quantity.value == "4"
    assert quantity.decision == "assigned"
    assert quantity.provenance["quantity_type"] == "order_header_item_count"


def test_quantity_multi_item_ambiguity_does_not_mature(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"quantity-multi-item-{index}.eml",
                f"Order #{9000 + index}\n"
                "Product: First Ornament\n"
                "Quantity: 1\n"
                "Price: $35.00\n"
                "Product: Second Ornament\n"
                "Quantity: 2\n"
                "Price: $42.00\n",
            ),
            update_confidence=True,
        )
        quantity = next(d for d in result["decisions"] if d.field == "quantity")
        assert quantity.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("quantity")
        if record["trust_state"] == "promoted"
    ]


def test_order_date_confidence_signature_uses_body_structure(tmp_path, isolated_learning_store):
    result = parse_eml(
        _make_eml(
            tmp_path / "order-date-signature.eml",
            "Order #8101\nOrder date: Apr 10, 2026\nPrice: $35.00\n",
        ),
        update_confidence=False,
    )
    candidate = next(c for c in result["candidates"] if c.field_type == "date" and c.extractor == "date_regex")
    signature = build_order_date_confidence_signature(
        candidate,
        result["segment_map"],
        result["segments"],
        result["candidates"],
    )

    assert is_safe_order_date_candidate(candidate, result["segments"], result["segment_map"], result["candidates"])
    assert signature.startswith("date_regex|body|explicit_order_date|order_date|order|same_line|not_metadata|")


def test_order_date_body_matures_and_replays_current_value(tmp_path, isolated_learning_store):
    last = None
    for index, date_value in enumerate(("Apr 10, 2026", "Apr 11, 2026", "Apr 12, 2026", "Apr 13, 2026"), start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"order-date-body-{index}.eml",
                f"Order #{8100 + index}\nOrder date: {date_value}\nPrice: $35.00\n",
            ),
            update_confidence=True,
        )

    order_date = next(d for d in last["decisions"] if d.field == "order_date")
    assert order_date.value == "Apr 13, 2026"
    assert order_date.decision == "assigned"
    assert order_date.decision_source == "order_date_structural_maturity_promotion"
    assert order_date.provenance["why_assigned"] == "safe_order_date_structural_maturity"
    assert order_date.provenance["metadata_fallback_used"] is False

    followup = parse_eml(
        _make_eml(
            tmp_path / "order-date-body-followup.eml",
            "Order #8105\nOrder date: Apr 14, 2026\nPrice: $35.00\n",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "order_date")
    assert replayed.value == "Apr 14, 2026"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "order_date_structural_trust_replay"
    assert replayed.provenance["order_date_structural_replay_used"] is True
    assert replayed.provenance["why_assigned"] == "trusted_order_date_structural_replay_current_value"


def test_order_date_subject_event_can_mature(tmp_path, isolated_learning_store):
    for index, date_value in enumerate(("Apr 10, 2026", "Apr 11, 2026", "Apr 12, 2026", "Apr 13, 2026"), start=1):
        result = parse_eml(
            _make_eml(
                tmp_path / f"order-date-subject-{index}.eml",
                f"Order #{8200 + index}\nPrice: $35.00\n",
                subject=f"Order #{8200 + index} placed on {date_value}",
            ),
            update_confidence=True,
        )

    order_date = next(d for d in result["decisions"] if d.field == "order_date")
    assert order_date.value == "Apr 13, 2026"
    assert order_date.decision == "assigned"
    assert order_date.decision_source == "order_date_structural_maturity_promotion"
    assert order_date.provenance["source_priority_used"] == "subject_order_event_date"


def test_order_date_metadata_fallback_and_body_suppression(tmp_path, isolated_learning_store):
    fallback = parse_eml(
        _make_eml(
            tmp_path / "order-date-metadata-only.eml",
            "Order #8301\nPrice: $35.00\n",
        ),
        update_confidence=True,
    )
    fallback_date = next(d for d in fallback["decisions"] if d.field == "order_date")
    assert fallback_date.value == "April 10, 2026"
    assert fallback_date.provenance["metadata_fallback_used"] is True
    assert fallback_date.provenance["source_priority_used"] == "metadata_header"

    body = parse_eml(
        _make_eml(
            tmp_path / "order-date-body-suppresses-header.eml",
            "Order #8302\nOrder date: Apr 17, 2026\nPrice: $35.00\n",
        ),
        update_confidence=True,
    )
    body_date = next(d for d in body["decisions"] if d.field == "order_date")
    assert body_date.value == "Apr 17, 2026"
    assert body_date.provenance["metadata_fallback_used"] is False
    header_candidate = next(c for c in body["candidates"] if c.extractor == "date_header")
    assert not is_safe_order_date_candidate(header_candidate, body["segments"], body["segment_map"], body["candidates"])


@pytest.mark.parametrize(
    "label,body",
    [
        ("ship_by", "Order #8401\nShip by: Apr 17\nPrice: $35.00\n"),
        ("delivery", "Order #8402\nEstimated delivery: Apr 17\nPrice: $35.00\n"),
        ("payment", "Order #8403\nPayment date: Apr 17\nPrice: $35.00\n"),
        ("tracking", "Order #8404\nTracking update: Apr 17\nPrice: $35.00\n"),
        ("footer", "Order #8405\nNeed help? Contact support Apr 17\nPrice: $35.00\n"),
        ("invoice", "Order #8406\nInvoice due date: Apr 17\nPrice: $35.00\n"),
        ("generic", "Order #8407\nApr 17\nPrice: $35.00\n"),
    ],
)
def test_order_date_unsafe_contexts_do_not_assign_body_date(tmp_path, isolated_learning_store, label, body):
    result = parse_eml(
        _make_eml(tmp_path / f"order-date-unsafe-{label}.eml", body),
        update_confidence=True,
    )

    order_date = next((d for d in result["decisions"] if d.field == "order_date"), None)
    if order_date is not None:
        assert order_date.value != "Apr 17"

    body_candidate = next(c for c in result["candidates"] if c.field_type == "date" and c.extractor == "date_regex")
    assert not is_safe_order_date_candidate(body_candidate, result["segments"], result["segment_map"], result["candidates"])


def test_ship_by_confidence_signature_uses_subject_structure(tmp_path, isolated_learning_store):
    result = parse_eml(
        _make_eml(
            tmp_path / "ship-by-signature.eml",
            "Order #9101\nPrice: $35.00\n",
            subject="Order #9101 - Ship by Apr 17",
        ),
        update_confidence=False,
    )
    candidate = next(c for c in result["candidates"] if c.field_type == "ship_by")
    signature = build_ship_by_confidence_signature(candidate, result["segment_map"], result["segments"])

    assert is_safe_ship_by_candidate(candidate, result["segments"], result["segment_map"])
    assert signature == "ship_by_subject_regex|subject|ship_by|ship_by_date|subject|subject|subject_line"


def test_ship_by_subject_matures_and_replays_current_value(tmp_path, isolated_learning_store):
    last = None
    for index, date_value in enumerate(("Apr 17", "Apr 18", "Apr 19", "Apr 20"), start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"ship-by-subject-{index}.eml",
                f"Order #{9100 + index}\nPrice: $35.00\n",
                subject=f"Order #{9100 + index} - Ship by {date_value}",
            ),
            update_confidence=True,
        )

    ship_by = next(d for d in last["decisions"] if d.field == "ship_by")
    assert ship_by.value == "Apr 20"
    assert ship_by.decision == "assigned"
    assert ship_by.decision_source == "ship_by_structural_maturity_promotion"
    assert ship_by.provenance["why_promoted"] == "safe_ship_by_structural_maturity"

    followup = parse_eml(
        _make_eml(
            tmp_path / "ship-by-subject-followup.eml",
            "Order #9105\nPrice: $35.00\n",
            subject="Order #9105 - Ship by Apr 21",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "ship_by")
    assert replayed.value == "Apr 21"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "ship_by_structural_trust_replay"
    assert replayed.provenance["ship_by_structural_replay_used"] is True


def test_ship_by_body_dispatch_and_estimated_ship_date_can_mature(tmp_path, isolated_learning_store):
    for index, date_value in enumerate(("May 1", "May 2", "May 3", "May 4"), start=1):
        result = parse_eml(
            _make_eml(
                tmp_path / f"ship-by-dispatch-{index}.eml",
                f"Order #{9200 + index}\n"
                f"Dispatch by: {date_value}\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )
    dispatch = next(d for d in result["decisions"] if d.field == "ship_by")
    assert dispatch.value == "May 4"
    assert dispatch.decision == "assigned"

    for index, date_value in enumerate(("Jun 1", "Jun 2", "Jun 3", "Jun 4"), start=1):
        result = parse_eml(
            _make_eml(
                tmp_path / f"ship-by-estimated-{index}.eml",
                f"Order #{9300 + index}\n"
                f"Estimated ship date: {date_value}\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )
    estimated = next(d for d in result["decisions"] if d.field == "ship_by")
    assert estimated.value == "Jun 4"
    assert estimated.decision == "assigned"


def test_ship_by_delivery_payment_tracking_and_footer_do_not_mature(tmp_path, isolated_learning_store):
    bodies = [
        "Order #9401\nEstimated delivery: Apr 17\nPrice: $35.00\n",
        "Order #9402\nPayment date: Apr 17\nPrice: $35.00\n",
        "Order #9403\nTracking update: Apr 17\nPrice: $35.00\n",
        "Order #9404\nNeed help? Contact support Apr 17\nPrice: $35.00\n",
    ]
    for index in range(4):
        for body_index, body in enumerate(bodies):
            result = parse_eml(
                _make_eml(tmp_path / f"ship-by-unsafe-{index}-{body_index}.eml", body),
                update_confidence=True,
            )
            ship_by = next((d for d in result["decisions"] if d.field == "ship_by"), None)
            if ship_by is not None:
                assert ship_by.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("ship_by")
        if record["trust_state"] == "promoted"
    ]


def test_ship_by_nearby_boundary_safety_blocks_unstable_date(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"ship-by-nearby-unsafe-{index}.eml",
                f"Order #{9500 + index}\n"
                "Ship by\n"
                "Tracking update\n"
                "Apr 17\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )
        ship_by = next((d for d in result["decisions"] if d.field == "ship_by"), None)
        if ship_by is not None:
            assert ship_by.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("ship_by")
        if record["trust_state"] == "promoted"
    ]


def test_buyer_email_confidence_signature_uses_customer_structure(tmp_path, isolated_learning_store):
    result = parse_eml(
        _make_eml(
            tmp_path / "buyer-email-signature.eml",
            "Order #9601\n"
            "Customer email: jane.customer@example.com\n"
            "Price: $35.00\n",
        ),
        update_confidence=False,
    )
    candidate = next(c for c in result["candidates"] if c.field_type == "email")
    signature = build_buyer_email_confidence_signature(
        candidate,
        result["segment_map"],
        result["segments"],
        [candidate],
    )

    assert is_safe_buyer_email_candidate(candidate, [candidate], result["segments"])
    assert signature.startswith("email_regex|buyer_email|customer_email|customer|")
    assert "|primary_customer|" in signature


def test_buyer_email_customer_matures_and_replays_current_value(tmp_path, isolated_learning_store):
    last = None
    emails = (
        "jane.customer@example.com",
        "rachel.customer@example.com",
        "morgan.customer@example.com",
        "taylor.customer@example.com",
    )
    for index, email in enumerate(emails, start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"buyer-email-mature-{index}.eml",
                f"Order #{9600 + index}\n"
                f"Customer email: {email}\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )

    buyer_email = next(d for d in last["decisions"] if d.field == "buyer_email")
    assert buyer_email.value == "taylor.customer@example.com"
    assert buyer_email.decision == "assigned"
    assert buyer_email.decision_source == "buyer_email_structural_maturity_promotion"
    assert buyer_email.provenance["why_promoted"] == "safe_buyer_email_structural_maturity"

    followup = parse_eml(
        _make_eml(
            tmp_path / "buyer-email-followup.eml",
            "Order #9605\n"
            "Customer email: avery.current@example.com\n"
            "Price: $35.00\n",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "buyer_email")
    assert replayed.value == "avery.current@example.com"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "buyer_email_structural_trust_replay"
    assert replayed.provenance["buyer_email_structural_replay_used"] is True


def test_buyer_email_system_seller_support_platform_and_header_do_not_mature(tmp_path, isolated_learning_store):
    bodies = [
        "Order #9701\nCustomer email: no-reply@example.com\nPrice: $35.00\n",
        "Order #9702\nSeller email: owner@granite-store.test\nPrice: $35.00\n",
        "Order #9703\nNeed help? Contact support@example.com\nPrice: $35.00\n",
        "Order #9704\nNotification email: updates@marketplace-mail.test\nPrice: $35.00\n",
        "Order #9705\nFrom: seller@example.com\nPrice: $35.00\n",
    ]
    for index in range(4):
        for body_index, body in enumerate(bodies):
            result = parse_eml(
                _make_eml(tmp_path / f"buyer-email-unsafe-{index}-{body_index}.eml", body),
                update_confidence=True,
            )
            buyer_email = next((d for d in result["decisions"] if d.field == "buyer_email"), None)
            if buyer_email is not None:
                assert buyer_email.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("buyer_email")
        if record["trust_state"] == "promoted"
    ]


def test_buyer_email_billing_suppressed_when_customer_exists(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"buyer-email-billing-suppressed-{index}.eml",
                f"Order #{9800 + index}\n"
                "Billing email: billing@example.com\n"
                f"Customer email: customer{index}@example.com\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )
    buyer_email = next(d for d in result["decisions"] if d.field == "buyer_email")
    assert buyer_email.value == "customer3@example.com"
    assert not any(
        record["role"] == "billing_email" and record["trust_state"] == "promoted"
        for record in learning_store.load_structural_trust("buyer_email")
    )


def test_buyer_email_billing_fallback_can_mature_without_customer(tmp_path, isolated_learning_store):
    for index, email in enumerate((
        "billing.one@example.com",
        "billing.two@example.com",
        "billing.three@example.com",
        "billing.four@example.com",
    ), start=1):
        result = parse_eml(
            _make_eml(
                tmp_path / f"buyer-email-billing-fallback-{index}.eml",
                f"Order #{9900 + index}\n"
                f"Billing email: {email}\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )
    buyer_email = next(d for d in result["decisions"] if d.field == "buyer_email")
    assert buyer_email.value == "billing.four@example.com"
    assert buyer_email.decision == "assigned"
    assert buyer_email.provenance["buyer_email_role"] == "billing_email"


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


def test_shipping_address_confidence_signature_uses_line_policy(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "shipping-signature.eml",
        "Order #6101\n"
        "Shipping address\n"
        "Jane Buyer\n"
        "123 Maple Drive\n"
        "Austin, TX 78701\n"
        "United States\n",
    )
    result = parse_eml(eml, update_confidence=False)
    candidate = next(
        c for c in result["candidates"]
        if c.field_type == "shipping_address" and c.source == "shipping" and "Jane Buyer" in c.value
    )

    signature = build_shipping_address_confidence_signature(
        candidate,
        result["segment_map"],
        result["segments"],
        "Jane Buyer",
    )

    assert "shipping_address_block_with_recipient|shipping|shipping_address_block" in signature
    assert "name-street-city_state_zip-country" in signature
    assert "selected:street-city_state_zip" in signature
    assert "excluded:name-country" in signature
    assert "country_excluded" in signature


def test_shipping_address_structural_confidence_matures_and_replays_current_address(tmp_path, isolated_learning_store):
    addresses = [
        ("Jane Buyer", "123 Maple Drive", "Austin, TX 78701"),
        ("Rachel Customer", "900 Oak Road", "Denver, CO 80202"),
        ("Morgan Lane", "44 Pine Street", "Portland, OR 97201"),
        ("Taylor Stone", "88 Cedar Court", "Madison, WI 53703"),
    ]
    last = None
    for index, (name, street, city) in enumerate(addresses, start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"shipping-mature-{index}.eml",
                f"Order #{6200 + index}\n"
                "Shipping address\n"
                f"{name}\n"
                f"{street}\n"
                f"{city}\n"
                "United States\n"
                "Price: $35.00\n",
            ),
            update_confidence=True,
        )

    address = next(d for d in last["decisions"] if d.field == "shipping_address")
    assert address.value == "88 Cedar Court\nMadison, WI 53703"
    assert address.decision == "assigned"
    assert address.decision_source == "shipping_address_structural_maturity_promotion"
    assert address.provenance["why_promoted"] == "safe_shipping_address_line_policy_maturity"

    followup = parse_eml(
        _make_eml(
            tmp_path / "shipping-replay-followup.eml",
            "Order #6205\n"
            "Shipping address\n"
            "Avery Current\n"
            "77 Birch Road\n"
            "Boise, ID 83702\n"
            "United States\n"
            "Price: $35.00\n",
        ),
        update_confidence=True,
    )
    replayed = next(d for d in followup["decisions"] if d.field == "shipping_address")
    assert replayed.value == "77 Birch Road\nBoise, ID 83702"
    assert replayed.decision == "assigned"
    assert replayed.decision_source == "shipping_address_structural_trust_replay"
    assert replayed.provenance["shipping_address_structural_replay_used"] is True


def test_shipping_address_maturation_suppresses_billing_when_shipping_exists(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"shipping-vs-billing-{index}.eml",
                f"Order #{6300 + index}\n"
                "Billing address\n"
                "Billing Person\n"
                "1 Billing Road\n"
                "Billingtown, TX 75001\n"
                "Shipping address\n"
                "Ship Person\n"
                f"{100 + index} Shipping Lane\n"
                "Shipcity, MN 55906\n"
                "United States\n",
            ),
            update_confidence=True,
        )
    address = next(d for d in result["decisions"] if d.field == "shipping_address")
    assert "Shipping Lane" in address.value
    assert "Billing Road" not in address.value
    assert not any(
        record["role"] == "billing_address_block"
        for record in learning_store.load_structural_trust("shipping_address")
    )


def test_shipping_address_maturation_excludes_name_company_and_country(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"shipping-company-country-{index}.eml",
                f"Order #{6400 + index}\n"
                "Shipping address\n"
                "Customer Person\n"
                "Acme Memorials LLC\n"
                f"{200 + index} Granite Drive\n"
                "Lansing, MI 48910\n"
                "United States\n",
            ),
            update_confidence=True,
        )
    address = next(d for d in result["decisions"] if d.field == "shipping_address")
    assert address.value == "203 Granite Drive\nLansing, MI 48910"
    assert "Customer Person" not in address.value
    assert "Acme Memorials LLC" not in address.value
    assert "United States" not in address.value


def test_shipping_address_maturation_preserves_apartment_continuity(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"shipping-apartment-{index}.eml",
                f"Order #{6500 + index}\n"
                "Shipping address\n"
                "Apartment Buyer\n"
                f"{300 + index} Oak Street\n"
                "Apt 5B\n"
                "Chicago, IL 60601\n"
                "United States\n",
            ),
            update_confidence=True,
        )
    address = next(d for d in result["decisions"] if d.field == "shipping_address")
    assert address.value == "303 Oak Street\nApt 5B\nChicago, IL 60601"


def test_shipping_address_footer_and_stop_too_late_do_not_mature(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"shipping-footer-{index}.eml",
                f"Order #{6600 + index}\n"
                "Shipping address\n"
                "Footer Buyer\n"
                f"{400 + index} Pine Road\n"
                "Miami, FL 33101\n"
                "Purchase Shipping Label\n"
                "Order total: $35.00\n",
            ),
            update_confidence=True,
        )
        address = next(d for d in result["decisions"] if d.field == "shipping_address")
        assert "Purchase Shipping Label" not in address.value
        assert "Order total" not in address.value

    assert any(
        record["role"] == "shipping_address_block"
        for record in learning_store.load_structural_trust("shipping_address")
    )


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


def test_item_price_confidence_signature_uses_safe_structure(tmp_path, isolated_learning_store):
    eml = _make_eml(
        tmp_path / "safe-item-price-signature.eml",
        "Order #7001\n"
        "Product: Memorial Ornament\n"
        "Quantity: 1\n"
        "Price: $35.00\n"
        "Shipping: $4.00\n"
        "Sales tax: $2.50\n"
        "Order total: $41.50\n",
    )
    result = parse_eml(eml, update_confidence=False)
    segment_map = {segment.id: segment for segment in result["segments"]}
    candidate = next(
        c for c in result["candidates"]
        if c.value == "35.00" and "Price:" in c.segment_text
    )

    signature = build_item_price_confidence_signature(candidate, segment_map, result["segments"])

    assert is_safe_item_price_candidate(candidate, result["segments"], segment_map)
    assert signature.startswith("number_regex|item_price|")
    assert "|line_item|" in signature
    assert "|item|" in signature
    assert signature != build_price_signature(candidate, segment_map, result["segments"])


def test_item_price_structural_confidence_matures_into_trust(tmp_path, isolated_learning_store):
    prices = ("35.00", "42.00", "44.00", "48.00")
    last = None
    for index, price in enumerate(prices, start=1):
        last = parse_eml(
            _make_eml(
                tmp_path / f"item-price-mature-{index}.eml",
                f"Order #{7000 + index}\n"
                "Product: Memorial Ornament\n"
                "Quantity: 1\n"
                f"Price: ${price}\n"
                "Shipping: $4.00\n"
                "Sales tax: $2.50\n"
                f"Order total: ${float(price) + 6.50:.2f}\n",
            ),
            update_confidence=True,
        )

    price_decision = next(d for d in last["decisions"] if d.field == "price")
    confidence = confidence_store._load()

    assert price_decision.value == "48.00"
    assert price_decision.decision == "assigned"
    assert price_decision.decision_source == "price_structural_maturity_promotion"
    assert price_decision.provenance["why_promoted"] == "safe_item_price_structural_maturity"
    assert any(
        record["field"] == "price"
        and record["extraction_signature"].startswith("number_regex|item_price|")
        and record["streak_count"] >= 4
        for record in confidence.values()
    )
    assert any(
        record["field"] == "price"
        and record["role"] == "item_price"
        and record["trust_state"] == "promoted"
        for record in learning_store.load_structural_trust("price", last["template_family_id"])
    )


def test_item_price_maturation_enables_future_structural_replay(tmp_path, isolated_learning_store):
    for index, price in enumerate(("35.00", "42.00", "44.00", "48.00"), start=1):
        parse_eml(
            _make_eml(
                tmp_path / f"item-price-replay-mature-{index}.eml",
                f"Order #{7100 + index}\n"
                "Product: Memorial Ornament\n"
                "Quantity: 1\n"
                f"Price: ${price}\n"
                "Shipping: $4.00\n"
                f"Order total: ${float(price) + 4.00:.2f}\n",
            ),
            update_confidence=True,
        )

    followup = parse_eml(
        _make_eml(
            tmp_path / "item-price-replay-followup.eml",
            "Order #7200\n"
            "Product: Memorial Ornament\n"
            "Quantity: 1\n"
            "Price: $52.00\n"
            "Shipping: $4.00\n"
            "Order total: $56.00\n",
        ),
        update_confidence=True,
    )
    price_decision = next(d for d in followup["decisions"] if d.field == "price")

    assert price_decision.value == "52.00"
    assert price_decision.decision == "assigned"
    assert price_decision.decision_source == "price_structural_trust_replay"
    assert price_decision.provenance["price_structural_replay_used"] is True


def test_order_total_shipping_tax_do_not_mature_as_item_price(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"summary-price-{index}.eml",
                f"Order #{7300 + index}\n"
                "Shipping: $4.00\n"
                "Sales tax: $2.50\n"
                "Subtotal: $35.00\n"
                "Order total: $41.50\n",
            ),
            update_confidence=True,
        )
        price_decision = next((d for d in result["decisions"] if d.field == "price"), None)
        if price_decision is not None:
            assert price_decision.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("price")
        if record["role"] == "item_price" and record["trust_state"] == "promoted"
    ]


def test_multi_item_prices_do_not_mature_ambiguous_item_price(tmp_path, isolated_learning_store):
    for index in range(4):
        result = parse_eml(
            _make_eml(
                tmp_path / f"multi-item-price-{index}.eml",
                f"Order #{7400 + index}\n"
                "Product: First Ornament\n"
                "Quantity: 1\n"
                "Price: $35.00\n"
                "Product: Second Ornament\n"
                "Quantity: 1\n"
                "Price: $42.00\n"
                "Order total: $77.00\n",
            ),
            update_confidence=True,
        )
        price_decision = next(d for d in result["decisions"] if d.field == "price")
        assert price_decision.decision != "assigned"

    assert not [
        record for record in learning_store.load_structural_trust("price")
        if record["role"] == "item_price" and record["trust_state"] == "promoted"
    ]


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


# ── Fix 3 regression: [CORRECTION_SYNTHESIS] and [ROLE_RULE_WRITTEN] logs ─────

def test_shipping_address_assignment_emits_correction_synthesis_log(
    tmp_path, isolated_learning_store, capsys,
):
    """Manual shipping address assignment must emit [CORRECTION_SYNTHESIS] and
    [ROLE_RULE_WRITTEN] proof logs so live debugging can confirm the path."""
    body = (
        "Order #5001\n"
        "Shipping address\n"
        "Alice Buyer\n"
        "789 Elm St\n"
        "Portland, OR 97201\n"
        "United States\n"
        "Price: $29.00\n"
    )
    eml_path = _make_eml(tmp_path / "synth-log.eml", body)
    initial = parse_eml(eml_path, update_confidence=False)
    selected_text = "789 Elm St\nPortland, OR 97201"
    start = initial["clean_text"].index(selected_text)
    end = start + len(selected_text)

    apply_learning("save_assignment", eml_path, {
        "field": "shipping_address",
        "value": selected_text,
        "selected_text": selected_text,
        "start": start,
        "end": end,
        "segment_id": "",
    })

    captured = capsys.readouterr()
    assert "[CORRECTION_SYNTHESIS]" in captured.err, (
        "apply_learning must emit [CORRECTION_SYNTHESIS] for manual assignments"
    )
    assert "[ROLE_RULE_WRITTEN]" in captured.err, (
        "apply_learning must emit [ROLE_RULE_WRITTEN] for address field assignments"
    )
    assert '"field": "shipping_address"' in captured.err


# ── Fix 2 regression: item price assignment writes backend learning store ──────

def test_item_price_manual_assignment_writes_learning_store(
    tmp_path, isolated_learning_store,
):
    """A manually corrected item price routed through apply_learning must write
    an assignment record so future emails of the same template auto-parse it."""
    body = (
        "Order #5002\n"
        "Product: Custom Mug\n"
        "Quantity: 1\n"
        "Price: $18.00\n"
        "Order total: $23.00\n"
    )
    eml_path = _make_eml(tmp_path / "item-price-learn.eml", body)
    initial = parse_eml(eml_path, update_confidence=False)
    template_id = initial["template_family_id"]

    selected_text = "18.00"
    start = initial["clean_text"].index(selected_text)
    end = start + len(selected_text)

    apply_learning("save_assignment", eml_path, {
        "field": "price",
        "value": selected_text,
        "selected_text": selected_text,
        "start": start,
        "end": end,
        "segment_id": "",
    })

    records = learning_store.load_assignments(template_id, "price")
    assert len(records) >= 1, "item price assignment must write a learning record"
    values = [r["value"] for r in records]
    assert selected_text in values, f"value {selected_text!r} not found in {values}"
