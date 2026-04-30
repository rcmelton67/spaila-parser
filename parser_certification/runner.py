from __future__ import annotations

import json
import platform
import time
from dataclasses import asdict, dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from parser.pipeline import parse_eml

from .generator import write_eml
from .isolation import isolated_parser_runtime, live_hashes
from .manifest import CertificationCase, CertificationManifest, SUPPORTED_TIERS, load_manifest
from .snapshots import (
    decision_snapshot,
    diff_store_summaries,
    read_json,
    stable_json_hash,
    store_summary,
    write_json,
)


FAIL_UNSAFE_ASSIGNMENT = "unsafe_assignment"
FAIL_FORBIDDEN_VALUE = "forbidden_value"
FAIL_MISSING_EXPECTED = "missing_expected"
FAIL_STORE_POLLUTION = "store_pollution"
FAIL_TRUST_DRIFT = "trust_drift"
FAIL_MISSING_PROVENANCE = "missing_provenance"


@dataclass
class CaseResult:
    case_id: str
    category: str
    tier: str
    passed: bool
    failure_codes: list[str] = field(default_factory=list)
    expected: dict[str, str] = field(default_factory=dict)
    actual: dict[str, str] = field(default_factory=dict)
    forbidden_hits: dict[str, list[str]] = field(default_factory=dict)
    decision_hash: str = ""
    trust_diff: dict[str, Any] = field(default_factory=dict)
    repetitions: int = 1
    duration_ms: int = 0


@dataclass
class CertificationReport:
    passed: bool
    tier: str
    manifest_id: str
    manifest_version: str
    parser_version: str
    python_version: str
    case_count: int
    passed_count: int
    failed_count: int
    live_store_integrity: bool
    live_hashes_before: dict[str, str]
    live_hashes_after: dict[str, str]
    decision_snapshot_hash: str
    trust_snapshot_hash: str
    cases: list[CaseResult]

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["cases"] = [asdict(case) for case in self.cases]
        return payload


class CertificationRunner:
    def __init__(self, output_dir: str | Path):
        self.output_dir = Path(output_dir)

    def run_manifest(self, manifest: CertificationManifest, tier: str = "smoke") -> CertificationReport:
        if tier not in SUPPORTED_TIERS:
            raise ValueError(f"tier must be one of {sorted(SUPPORTED_TIERS)}")

        selected = [case for case in manifest.cases if case.tier == tier or tier == "cert"]
        if tier == "cert":
            selected = list(manifest.cases)

        run_root = self.output_dir / manifest.manifest_id / tier
        run_root.mkdir(parents=True, exist_ok=True)

        with isolated_parser_runtime(run_root / "runtime") as runtime:
            case_results = [self._run_case(case, run_root, runtime) for case in selected]
            learning_payload = read_json(runtime["learning_store_path"])
            trust_summary = store_summary(learning_payload)
            live_before = dict(runtime["live_hashes_before"])

        live_after = live_hashes()
        live_store_integrity = live_before == live_after
        if not live_store_integrity:
            for result in case_results:
                result.passed = False
                if FAIL_STORE_POLLUTION not in result.failure_codes:
                    result.failure_codes.append(FAIL_STORE_POLLUTION)

        decision_hash = stable_json_hash([result.decision_hash for result in case_results])
        trust_hash = stable_json_hash(trust_summary)
        passed_count = sum(1 for result in case_results if result.passed)
        report = CertificationReport(
            passed=passed_count == len(case_results) and live_store_integrity,
            tier=tier,
            manifest_id=manifest.manifest_id,
            manifest_version=manifest.manifest_version,
            parser_version=_parser_version(),
            python_version=platform.python_version(),
            case_count=len(case_results),
            passed_count=passed_count,
            failed_count=len(case_results) - passed_count,
            live_store_integrity=live_store_integrity,
            live_hashes_before=live_before,
            live_hashes_after=live_after,
            decision_snapshot_hash=decision_hash,
            trust_snapshot_hash=trust_hash,
            cases=case_results,
        )
        write_json(run_root / "certification-report.json", report.to_dict())
        return report

    def _run_case(
        self,
        case: CertificationCase,
        run_root: Path,
        runtime: dict[str, Any],
    ) -> CaseResult:
        start = time.perf_counter()
        case_dir = run_root / "cases" / case.case_id
        before_summary = store_summary(read_json(runtime["learning_store_path"]))
        parse_result: dict[str, Any] | None = None

        for repetition in range(1, case.repetitions + 1):
            eml_path = write_eml(case, case_dir, repetition)
            parse_result = parse_eml(str(eml_path), update_confidence=case.update_confidence)

        assert parse_result is not None
        decisions = decision_snapshot(parse_result)
        actual = {row["field"]: row["value"] for row in decisions}
        failure_codes: list[str] = []

        for field, expected_value in case.expected.items():
            if actual.get(field) != expected_value:
                failure_codes.append(FAIL_MISSING_EXPECTED)
                break

        forbidden_hits: dict[str, list[str]] = {}
        for field, forbidden_values in case.forbidden.items():
            hit_values = [value for value in forbidden_values if actual.get(field) == value]
            if hit_values:
                forbidden_hits[field] = hit_values
        if forbidden_hits:
            failure_codes.append(FAIL_FORBIDDEN_VALUE)

        for row in decisions:
            if row["decision"] == "assigned" and not row.get("signals"):
                failure_codes.append(FAIL_MISSING_PROVENANCE)
                break

        after_summary = store_summary(read_json(runtime["learning_store_path"]))
        trust_diff = diff_store_summaries(before_summary, after_summary)

        required_trust_delta = case.trust_expectations.get("min_structural_trust_delta")
        if required_trust_delta is not None and trust_diff["structural_trust_delta"] < int(required_trust_delta):
            failure_codes.append(FAIL_TRUST_DRIFT)

        duration_ms = int((time.perf_counter() - start) * 1000)
        case_report = CaseResult(
            case_id=case.case_id,
            category=case.category,
            tier=case.tier,
            passed=not failure_codes,
            failure_codes=sorted(set(failure_codes)),
            expected=case.expected,
            actual=actual,
            forbidden_hits=forbidden_hits,
            decision_hash=stable_json_hash(decisions),
            trust_diff=trust_diff,
            repetitions=case.repetitions,
            duration_ms=duration_ms,
        )
        write_json(case_dir / "case-report.json", asdict(case_report))
        write_json(case_dir / "decision-snapshot.json", decisions)
        return case_report


def _parser_version() -> str:
    try:
        return metadata.version("spaila-parser")
    except metadata.PackageNotFoundError:
        return "editable"


def run_certification(
    manifest_path: str | Path,
    output_dir: str | Path,
    tier: str = "smoke",
) -> CertificationReport:
    manifest = load_manifest(manifest_path)
    return CertificationRunner(output_dir).run_manifest(manifest, tier=tier)


def report_to_text(report: CertificationReport) -> str:
    lines = [
        f"Certification {report.manifest_id} tier={report.tier}",
        f"passed={report.passed} cases={report.passed_count}/{report.case_count}",
        f"live_store_integrity={report.live_store_integrity}",
        f"decision_snapshot_hash={report.decision_snapshot_hash}",
        f"trust_snapshot_hash={report.trust_snapshot_hash}",
    ]
    for case in report.cases:
        status = "PASS" if case.passed else "FAIL"
        failures = ",".join(case.failure_codes) if case.failure_codes else "-"
        lines.append(f"{status} {case.case_id} failures={failures}")
    return "\n".join(lines)

