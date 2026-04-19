from parser.anchors.match import apply_anchor_scoring
from parser.extract import extract_numbers
from parser.ingest import load_eml
from parser.learning.store import load_store, save_assignment, save_rejection, save_store
from parser.pipeline import parse_eml
from parser.replay.fingerprint import compute_template_id
from parser.sanitize import sanitize
from parser.score import score_quantity, score_price
from parser.segment import segment


def _price_candidates(path: str):
    clean_text = sanitize(load_eml(path))
    template_id = compute_template_id(clean_text)
    segments = segment(clean_text)
    candidates = extract_numbers(segments)
    quantity_candidates = score_quantity(candidates, segments)
    price_candidates = score_price(candidates, segments, quantity_candidates)
    price_candidates = apply_anchor_scoring(template_id, "price", price_candidates)
    return template_id, price_candidates


def _clear_price_rejections(template_id: str) -> None:
    store = load_store()
    records = store.get(template_id, [])
    store[template_id] = [
        r for r in records
        if not (r.get("field") == "price" and r.get("type") == "reject")
    ]
    save_store(store)


def _print_reject_status(template_id: str, value: str) -> None:
    store = load_store()
    print("REJECT RECORDS")
    for record in store.get(template_id, []):
        if record.get("field") != "price" or record.get("type") != "reject":
            continue
        if record.get("value") != value:
            continue
        print(record.get("value"), record.get("active"), record.get("created_at"))


def _print_candidates(label: str, candidates, value: str) -> None:
    print(label)
    for c in candidates:
        if c.value != value:
            continue
        penalties = [p.replace("−", "-").replace("∞", "inf") for p in c.penalties]
        print(
            c.id,
            c.value,
            c.score,
            c.segment_id,
            repr(c.segment_text),
            c.signals,
            penalties,
        )


def main() -> None:
    path = "tests/samples/2353.eml"
    rejected_value = "29.99"

    template_id, before = _price_candidates(path)
    _clear_price_rejections(template_id)
    template_id, before = _price_candidates(path)

    _print_candidates("BEFORE REJECTION", before, rejected_value)

    rejected_candidate = next(
        c for c in before
        if c.value == rejected_value and c.segment_text == "$29.99"
    )
    save_rejection(template_id, "price", rejected_candidate)

    _, after = _price_candidates(path)
    print()
    _print_candidates("AFTER REJECTION", after, rejected_value)
    _print_reject_status(template_id, rejected_value)

    print()
    save_assignment(template_id, "price", rejected_candidate.value, rejected_candidate)
    _, healed = _price_candidates(path)
    _print_candidates("AFTER ASSIGNMENT", healed, rejected_value)
    _print_reject_status(template_id, rejected_value)

    result = parse_eml(path)
    decision = next(d for d in result["decisions"] if d.field == "price")
    provenance = repr(decision.provenance).replace("−", "-").replace("∞", "inf")

    print("\nFINAL DECISION")
    print(decision.field, decision.value, decision.confidence, provenance)


if __name__ == "__main__":
    main()
