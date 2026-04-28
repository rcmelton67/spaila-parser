from parser.segment import segment
from parser.extract import extract_buyer_name, extract_numbers, extract_shipping_address


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


# ── Fix 1 regression: duplicate address candidates with different roles ────────

def test_identical_billing_shipping_address_produces_separate_candidates():
    """Identical address text under Billing and Shipping must produce two distinct
    candidates, one per source, so role-based replay can distinguish them."""
    segs = segment(
        "Billing address\n"
        "123 Main St\n"
        "Austin, TX 78701\n"
        "Shipping address\n"
        "123 Main St\n"
        "Austin, TX 78701\n"
    )
    candidates = extract_shipping_address(segs)
    sources = {c.source for c in candidates}
    assert "billing" in sources, "billing-source candidate must survive"
    assert "shipping" in sources, "shipping-source candidate must survive"
    # Extractors must be source-qualified so signatures are role-distinct
    extractors = {c.extractor for c in candidates}
    assert any("billing" in e for e in extractors)
    assert any("shipping" in e for e in extractors)


def test_buyer_name_dedup_preserves_billing_and_shipping_sources():
    """Same buyer name under both Billing and Shipping must survive dedup as two
    candidates (one per source) so scoring can prefer the shipping-side one."""
    segs = segment(
        "Billing address\n"
        "Jane Smith\n"
        "123 Main St\n"
        "Austin, TX 78701\n"
        "Shipping address\n"
        "Jane Smith\n"
        "456 Oak Ave\n"
        "Denver, CO 80202\n"
    )
    candidates = extract_buyer_name(segs)
    jane_candidates = [c for c in candidates if "Jane Smith" in c.value]
    sources = {c.source for c in jane_candidates}
    assert "billing" in sources, "billing-sourced buyer name must be preserved"
    assert "shipping" in sources, "shipping-sourced buyer name must be preserved"
