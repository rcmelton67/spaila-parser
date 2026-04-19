import sys

from .pipeline import parse_eml


def _find_unique(text: str, needle: str) -> tuple[int, int]:
    start = text.find(needle)
    if start == -1:
        raise ValueError(f'Could not find "{needle}" in clean_text')
    if text.find(needle, start + 1) != -1:
        raise ValueError(f'"{needle}" is ambiguous in clean_text')
    return start, start + len(needle)


def _print_check(field: str, selected_text: str, start: int, end: int, clean_text: str) -> None:
    sliced = clean_text[start:end]
    print(f"FIELD: {field}")
    print(f'SELECTED_TEXT: "{selected_text}"')
    print(f"START: {start}")
    print(f"END: {end}")
    print(f'SLICE: "{sliced}"')
    print(f"MATCH: {'true' if selected_text == sliced else 'false'}")
    print()


def run_custom_field_assignment(path: str) -> None:
    result = parse_eml(path)
    clean_text = result["clean_text"]
    selected_text = "Forever Loved"
    start, end = _find_unique(clean_text, selected_text)
    _print_check("custom_1", selected_text, start, end, clean_text)


def run_price_reassignment(path: str) -> None:
    result = parse_eml(path)
    clean_text = result["clean_text"]
    price_decision = next((d for d in result["decisions"] if d.field == "price"), None)
    if not price_decision or price_decision.start is None or price_decision.end is None:
        raise ValueError("Could not find a price decision with start/end")
    selected_text = clean_text[price_decision.start:price_decision.end]
    _print_check("price", selected_text, price_decision.start, price_decision.end, clean_text)


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        raise SystemExit("Usage: py -m parser.debug_manual_assignment <eml-path>")

    path = argv[1]
    run_custom_field_assignment(path)
    run_price_reassignment(path)


if __name__ == "__main__":
    main(sys.argv)
