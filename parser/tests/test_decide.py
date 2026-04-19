from parser.segment import segment
from parser.extract import extract_numbers
from parser.score import score_quantity
from parser.decide import decide_quantity
from parser.models import DecisionRow


def _run(text: str):
    segs = segment(text)
    candidates = extract_numbers(segs)
    candidates = score_quantity(candidates, segs)
    return decide_quantity(candidates)


def test_decide_returns_decision_row():
    result = _run("Quantity: 5")
    assert isinstance(result, DecisionRow)


def test_decide_field_is_quantity():
    result = _run("Quantity: 5")
    assert result.field == "quantity"


def test_decide_confidence_between_0_and_1():
    result = _run("Quantity: 5")
    assert 0.0 <= result.confidence <= 1.0


def test_decide_returns_none_when_no_valid_candidates():
    result = _run("total $999.99 order subtotal $50")
    assert result is None


def test_decide_is_stable():
    result1 = _run("Quantity: 3")
    result2 = _run("Quantity: 3")
    assert result1.value == result2.value
    assert result1.candidate_id == result2.candidate_id
