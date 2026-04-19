import sys
from .pipeline import parse_eml


def main(path: str) -> None:
    result = parse_eml(path)

    clean_text = result["clean_text"]
    segments = result["segments"]
    all_candidates = result["candidates"]
    decisions = result["decisions"]

    preview = clean_text[:500]
    print(f"\n--- Clean Text Preview ---\n{preview}\n")

    print(f"Segments: {len(segments)}\n")

    for c in all_candidates:
        print("[CANDIDATE]")
        print(f"  value      : {c.value}")
        print(f"  segment_id : {c.segment_id}")
        print(f"  score      : {c.score}")
        print(f"  signals    : {c.signals}")
        print(f"  penalties  : {c.penalties}")

    print()

    if decisions:
        for d in decisions:
            print("[DECISION]")
            print(f"  field      : {d.field}")
            print(f"  value      : {d.value}")
            print(f"  confidence : {d.confidence:.3f}")
            print(f"  signals    : {d.provenance['signals']}")
    else:
        print("[DECISION]\n  No decision could be made.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m parser.cli <path/to/file.eml>")
        sys.exit(1)
    main(sys.argv[1])
