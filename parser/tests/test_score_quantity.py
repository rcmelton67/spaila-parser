from parser.segment import segment
from parser.extract import extract_numbers
from parser.score import score_quantity


def test_score_quantity_assigns_score():
    segs = segment("Quantity: 5")
    candidates = extract_numbers(segs)
    scored = score_quantity(candidates, segs)
    assert any(c.score != 0.0 for c in scored)


def test_score_positive_for_quantity_keyword():
    segs = segment("quantity 3")
    candidates = extract_numbers(segs)
    scored = score_quantity(candidates, segs)
    assert scored[0].score > 0


def test_score_positive_for_qty_keyword():
    segs = segment("qty 2")
    candidates = extract_numbers(segs)
    scored = score_quantity(candidates, segs)
    assert scored[0].score > 0


def test_score_no_currency_penalty_in_quantity():
    # $ is no longer a penalty in score_quantity — it belongs to score_price only
    segs = segment("$150 total")
    candidates = extract_numbers(segs)
    scored = score_quantity(candidates, segs)
    assert not any("currency:$" in p for c in scored for p in c.penalties)


def test_score_signals_and_penalties_are_strings():
    segs = segment("quantity 5\norder total $200")
    candidates = extract_numbers(segs)
    scored = score_quantity(candidates, segs)
    for c in scored:
        for s in c.signals + c.penalties:
            assert isinstance(s, str)
