import sys

from .pipeline import parse_eml


def run(path: str) -> None:
    result = parse_eml(path)
    clean_text = result["clean_text"]

    print(f"FILE: {path}")
    for decision in result["decisions"]:
        if decision.start is None or decision.end is None:
            sliced = ""
            match = False
        else:
            sliced = clean_text[decision.start:decision.end]
            match = sliced == decision.value

        print(f"FIELD: {decision.field}")
        print(f'VALUE: "{decision.value}"')
        print(f'SLICE: "{sliced}"')
        print(f"MATCH: {'true' if match else 'false'}")
        print()


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        raise SystemExit("Usage: py -m parser.debug_integrity <path> [<path> ...]")

    for index, path in enumerate(argv[1:]):
        if index:
            print("=" * 40)
        run(path)


if __name__ == "__main__":
    main(sys.argv)
