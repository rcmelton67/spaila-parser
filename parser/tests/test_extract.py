from parser.segment import segment
from parser.extract import extract_numbers


def test_extract_finds_numbers():
    segs = segment("Quantity: 5\nPrice: 99.99")
    candidates = extract_numbers(segs)
    assert len(candidates) > 0


def test_extract_candidate_fields():
    segs = segment("Qty 3")
    candidates = extract_numbers(segs)
    assert len(candidates) == 1
    c = candidates[0]
    assert c.field_type == "number"
    assert c.extractor == "number_regex"
    assert c.value == "3"
    assert c.raw_text == "3"


def test_extract_absolute_offsets():
    text = "Hello\n5 items"
    segs = segment(text)
    candidates = extract_numbers(segs)
    assert len(candidates) == 1
    assert candidates[0].start == 6


def test_extract_ids_sequential():
    segs = segment("1 and 2 and 3")
    candidates = extract_numbers(segs)
    assert candidates[0].id == "cand_0001"
    assert candidates[1].id == "cand_0002"
    assert candidates[2].id == "cand_0003"


def test_extract_no_numbers_returns_empty():
    segs = segment("No numbers here")
    candidates = extract_numbers(segs)
    assert candidates == []
