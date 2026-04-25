from pathlib import Path

import pytest

from parser.pipeline import parse_eml
from parser.replay.fingerprint import compute_template_id
from parser.learning import confidence_store
from parser.learning import store as learning_store


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
    context = {
        "value": price.value,
        "segment_id": price_candidate.segment_id,
        "start": price_candidate.start,
        "end": price_candidate.end,
        "selected_text": price_candidate.raw_text,
        "segment_text": price_candidate.segment_text,
        "left_context": price_candidate.left_context,
        "right_context": price_candidate.right_context,
    }

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
        if decision.start is None or decision.end is None:
            continue
        assert decision.start is not None, f"{sample_path} {decision.field} has no start"
        assert decision.end is not None, f"{sample_path} {decision.field} has no end"
        assert result["clean_text"][decision.start:decision.end] == decision.value, (
            f"{sample_path} {decision.field} -> "
            f'value="{decision.value}" slice="{result["clean_text"][decision.start:decision.end]}"'
        )
