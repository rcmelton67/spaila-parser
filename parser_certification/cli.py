from __future__ import annotations

import argparse
from importlib import resources
from pathlib import Path

from .runner import report_to_text, run_certification


def _default_manifest() -> Path:
    return Path(resources.files("parser_certification") / "manifests" / "smoke.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run standalone parser certification tiers.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run a certification manifest.")
    run_parser.add_argument("--manifest", default=str(_default_manifest()))
    run_parser.add_argument("--tier", default="smoke")
    run_parser.add_argument("--output-dir", default="output/parser_certification")
    run_parser.add_argument("--json", action="store_true", help="Only write report JSON; suppress text summary.")

    args = parser.parse_args(argv)
    if args.command == "run":
        report = run_certification(args.manifest, args.output_dir, tier=args.tier)
        if not args.json:
            print(report_to_text(report))
        return 0 if report.passed else 1
    return 2

