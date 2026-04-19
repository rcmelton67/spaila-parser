from parser.segment import segment


def test_segment_count_greater_than_zero():
    segs = segment("Line one\nLine two\nLine three")
    assert len(segs) > 0


def test_segment_ids_are_unique():
    segs = segment("A\nB\nC")
    ids = [s.id for s in segs]
    assert len(ids) == len(set(ids))


def test_segment_offsets_are_correct():
    text = "Hello\nWorld"
    segs = segment(text)
    assert segs[0].start == 0
    assert segs[0].end == 5
    assert segs[1].start == 6
    assert segs[1].end == 11


def test_segment_text_matches_line():
    text = "Quantity: 3\nOrder total: $99"
    segs = segment(text)
    assert segs[0].text == "Quantity: 3"
    assert segs[1].text == "Order total: $99"


def test_segment_line_index():
    segs = segment("A\nB\nC")
    for i, seg in enumerate(segs):
        assert seg.line_index == i
