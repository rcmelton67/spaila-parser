import argparse
import copy
import json
import shutil
from contextlib import contextmanager
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from . import pipeline
from .learning import admin as learning_admin
from .learning import confidence_store
from .learning import store as learning_store
from .pipeline import parse_eml
from .replay.fingerprint import compute_template_family_id

CORE_FIELDS = [
    "order_number",
    "price",
    "shipping_address",
    "buyer_name",
    "quantity",
    "ship_by",
    "buyer_email",
    "order_date",
]
REPORT_FIELD_MAP = {"price": "item_price"}
MANIFEST_SCHEMA_VERSION = 1
TREND_RECORD_VERSION = "parser_audit_trend_v1"
DEFAULT_SEVERITY = "medium"
SEVERITY_ORDER = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


@dataclass
class CaseResult:
    case_id: str
    platform_family: str
    kind: str
    severity: str
    passed: bool
    failures: List[Dict[str, Any]]
    decisions: Dict[str, str]
    trust_report: Dict[str, Any]
    template_family_id: str


def parser_version() -> str:
    try:
        return metadata.version("spaila-parser")
    except metadata.PackageNotFoundError:
        return "0.1.0"


def load_json(path: Path, default: Any | None = None) -> Any:
    if not path.exists():
        if default is not None:
            return copy.deepcopy(default)
        raise FileNotFoundError(path)
    return json.loads(path.read_text(encoding="utf-8"))


def repo_root_from(path: Path) -> Path:
    current = path.resolve()
    for parent in [current.parent, *current.parents]:
        if parent.joinpath("pyproject.toml").exists():
            return parent
    return current.parent


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_expected_fields(path: Path) -> Dict[str, str]:
    payload = load_json(path)
    if isinstance(payload, dict) and "fields" in payload:
        payload = payload["fields"]
    if isinstance(payload, dict):
        return {str(field): "" if value is None else str(value) for field, value in payload.items()}
    return {
        str(item["field"]): "" if item.get("value") is None else str(item.get("value", ""))
        for item in payload
    }


def decisions_to_fields(decisions: Iterable[Any]) -> Dict[str, str]:
    return {row.field: "" if row.value is None else str(row.value) for row in decisions}


def validate_manifest(manifest: Dict[str, Any], root_dir: Path | None = None) -> List[str]:
    errors: List[str] = []
    root = root_dir or Path.cwd()
    metadata_payload = manifest.get("metadata", {})
    required_metadata = [
        "parser_version",
        "trust_schema_version",
        "field_model_versions",
        "severity_classification",
    ]
    for key in required_metadata:
        if key not in metadata_payload:
            errors.append(f"metadata.{key} missing")
    field_versions = metadata_payload.get("field_model_versions", {})
    for field in CORE_FIELDS:
        if field not in field_versions:
            errors.append(f"metadata.field_model_versions.{field} missing")
    severity = metadata_payload.get("severity_classification", {})
    for label in SEVERITY_ORDER:
        if label not in severity:
            errors.append(f"metadata.severity_classification.{label} missing")
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        errors.append(f"schema_version must be {MANIFEST_SCHEMA_VERSION}")
    if not isinstance(manifest.get("cases"), list) or not manifest.get("cases"):
        errors.append("cases must be a non-empty list")
    covered_platforms = set(manifest.get("platform_coverage") or [])
    case_platforms = {
        case.get("platform_family", "")
        for case in manifest.get("cases", [])
        if case.get("platform_family")
    }
    for platform in sorted(covered_platforms - case_platforms):
        errors.append(f"platform_coverage.{platform} has no matching case")
    case_ids = set()
    for index, case in enumerate(manifest.get("cases", [])):
        case_id = case.get("case_id")
        if not case_id:
            errors.append(f"cases[{index}].case_id missing")
        elif case_id in case_ids:
            errors.append(f"duplicate case_id: {case_id}")
        case_ids.add(case_id)
        for key in ("platform_family", "kind", "severity", "eml_path", "expected_path", "store_mode"):
            if key not in case:
                errors.append(f"{case_id or index}.{key} missing")
        if case.get("severity", DEFAULT_SEVERITY) not in SEVERITY_ORDER:
            errors.append(f"{case_id or index}.severity unknown")
        for path_key in ("eml_path", "expected_path", "trust_snapshot_path"):
            if not case.get(path_key):
                continue
            if not root.joinpath(case[path_key]).exists():
                errors.append(f"{case_id or index}.{path_key} not found: {case[path_key]}")
    return errors


def normalize_trust_report(report: Dict[str, Any]) -> Dict[str, Any]:
    fields = {}
    for field, payload in sorted((report.get("fields") or {}).items()):
        fields[field] = {
            "final_value": payload.get("final_value", ""),
            "decision": payload.get("decision", ""),
            "decision_source": payload.get("decision_source", ""),
            "confidence": payload.get("confidence", 0.0),
            "structural_signature": payload.get("structural_signature", ""),
            "confidence_signature": payload.get("confidence_signature", ""),
            "trust_state": payload.get("trust_state", ""),
            "replay_source": payload.get("replay_source", ""),
            "maturity_state": payload.get("maturity_state", ""),
            "block_reasons": payload.get("block_reasons", []),
            "safety": payload.get("safety", {}),
        }
    return {
        "schema_version": report.get("schema_version"),
        "parse_run_id": report.get("parse_run_id", ""),
        "template_family_id": report.get("template_family_id", ""),
        "learning_source": report.get("learning_source", ""),
        "summary": report.get("summary", {}),
        "fields": fields,
    }


def _subset_diff(expected: Any, actual: Any, path: str = "") -> List[Dict[str, Any]]:
    diffs: List[Dict[str, Any]] = []
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [{"path": path, "expected": expected, "actual": actual}]
        for key, value in expected.items():
            next_path = f"{path}.{key}" if path else str(key)
            if key not in actual:
                diffs.append({"path": next_path, "expected": value, "actual": "<missing>"})
            else:
                diffs.extend(_subset_diff(value, actual[key], next_path))
        return diffs
    if isinstance(expected, list):
        if expected != actual:
            diffs.append({"path": path, "expected": expected, "actual": actual})
        return diffs
    if expected != actual:
        diffs.append({"path": path, "expected": expected, "actual": actual})
    return diffs


@contextmanager
def isolated_parser_paths(case_id: str, store_mode: str, output_dir: Path):
    original_learning_path = learning_store.STORE_PATH
    original_confidence_path = confidence_store.CONFIDENCE_STORE_PATH
    original_report_dir = pipeline.TRUST_REPORT_DIR

    case_dir = output_dir / "isolated_runtime" / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    learning_path = case_dir / "learning_store.json"
    confidence_path = case_dir / "confidence_store.json"
    report_dir = case_dir / "trust_reports"

    if store_mode == "live_copy_readonly":
        source_learning = Path(original_learning_path)
        source_confidence = Path(original_confidence_path)
        if source_learning.exists():
            shutil.copyfile(source_learning, learning_path)
        else:
            learning_path.write_text("{}", encoding="utf-8")
        if source_confidence.exists():
            shutil.copyfile(source_confidence, confidence_path)
        else:
            confidence_path.write_text("{}", encoding="utf-8")
    else:
        learning_path.write_text("{}", encoding="utf-8")
        confidence_path.write_text("{}", encoding="utf-8")

    learning_store.STORE_PATH = str(learning_path)
    confidence_store.CONFIDENCE_STORE_PATH = str(confidence_path)
    pipeline.TRUST_REPORT_DIR = report_dir
    try:
        yield learning_path, confidence_path, report_dir
    finally:
        learning_store.STORE_PATH = original_learning_path
        confidence_store.CONFIDENCE_STORE_PATH = original_confidence_path
        pipeline.TRUST_REPORT_DIR = original_report_dir


def _case_failure(case: Dict[str, Any], failure_type: str, detail: Dict[str, Any]) -> Dict[str, Any]:
    severity = case.get("severity", DEFAULT_SEVERITY)
    return {
        "case_id": case.get("case_id", ""),
        "platform_family": case.get("platform_family", "unknown"),
        "failure_type": failure_type,
        "severity": severity,
        "failure_severity": severity,
        **detail,
    }


def run_case(case: Dict[str, Any], root_dir: Path, output_dir: Path) -> CaseResult:
    case_id = case["case_id"]
    severity = case.get("severity", DEFAULT_SEVERITY)
    eml_path = root_dir / case["eml_path"]
    expected_path = root_dir / case["expected_path"]
    expected = load_expected_fields(expected_path)
    failures: List[Dict[str, Any]] = []

    with isolated_parser_paths(case_id, case.get("store_mode", "empty"), output_dir):
        result = parse_eml(str(eml_path), update_confidence=bool(case.get("update_confidence", False)))
        decisions = decisions_to_fields(result["decisions"])
        trust_report = normalize_trust_report(result.get("trust_report") or {})

    for field, expected_value in expected.items():
        actual_value = decisions.get(field, "")
        if actual_value != expected_value:
            failures.append(_case_failure(case, "field_mismatch", {
                "field": field,
                "expected": expected_value,
                "actual": actual_value,
            }))

    for field in case.get("required_fields", []):
        if not decisions.get(field, ""):
            failures.append(_case_failure(case, "required_field_missing", {"field": field}))

    expected_sources = case.get("expected_decision_sources", {})
    for field, expected_source in expected_sources.items():
        report_field = REPORT_FIELD_MAP.get(field, field)
        actual_source = (trust_report.get("fields", {}).get(report_field) or {}).get("decision_source", "")
        if actual_source != expected_source:
            failures.append(_case_failure(case, "decision_source_mismatch", {
                "field": field,
                "expected": expected_source,
                "actual": actual_source,
            }))

    snapshot_path = case.get("trust_snapshot_path")
    if snapshot_path:
        expected_snapshot = load_json(root_dir / snapshot_path)
        snapshot_diffs = _subset_diff(expected_snapshot, trust_report)
        for diff in snapshot_diffs:
            failures.append(_case_failure(case, "trust_snapshot_diff", diff))

    return CaseResult(
        case_id=case_id,
        platform_family=case.get("platform_family", "unknown"),
        kind=case.get("kind", "unknown"),
        severity=severity,
        passed=not failures,
        failures=failures,
        decisions=decisions,
        trust_report=trust_report,
        template_family_id=trust_report.get("template_family_id", ""),
    )


def _filter_cases(cases: List[Dict[str, Any]], tiers: set[str] | None, case_ids: set[str] | None) -> List[Dict[str, Any]]:
    selected = []
    for case in cases:
        if case_ids and case.get("case_id") not in case_ids:
            continue
        if tiers and not tiers.intersection(set(case.get("ci_tiers", []))):
            continue
        selected.append(case)
    return selected


def validate_family_grouping(cases: List[Dict[str, Any]], results: Dict[str, CaseResult]) -> List[Dict[str, Any]]:
    failures: List[Dict[str, Any]] = []
    for case in cases:
        case_id = case["case_id"]
        current = results.get(case_id)
        if not current:
            continue
        relationships = case.get("expected_family_relationships", {})
        for peer_id in relationships.get("same_family_as", []):
            peer = results.get(peer_id)
            if peer and peer.template_family_id != current.template_family_id:
                failures.append(_case_failure(case, "family_group_mismatch", {
                    "expected_relationship": "same_family_as",
                    "peer_case_id": peer_id,
                    "actual": [current.template_family_id, peer.template_family_id],
                }))
        for peer_id in relationships.get("different_family_from", []):
            peer = results.get(peer_id)
            if peer and peer.template_family_id == current.template_family_id:
                failures.append(_case_failure(case, "family_group_mismatch", {
                    "expected_relationship": "different_family_from",
                    "peer_case_id": peer_id,
                    "actual": current.template_family_id,
                }))
    return failures


def marketplace_drift_hooks(cases: List[Dict[str, Any]], results: Dict[str, CaseResult]) -> Dict[str, Any]:
    platform_rows: Dict[str, Dict[str, Any]] = {}
    for case in cases:
        platform = case.get("platform_family", "unknown")
        row = platform_rows.setdefault(platform, {
            "case_count": 0,
            "failed_case_count": 0,
            "observed_template_families": [],
            "drift_signals": [],
        })
        result = results.get(case["case_id"])
        if not result:
            continue
        row["case_count"] += 1
        if not result.passed:
            row["failed_case_count"] += 1
            row["drift_signals"].append("case_failure")
        if result.template_family_id and result.template_family_id not in row["observed_template_families"]:
            row["observed_template_families"].append(result.template_family_id)

    for platform, row in platform_rows.items():
        if row["case_count"] > 1 and len(row["observed_template_families"]) > row["case_count"]:
            row["drift_signals"].append("unexpected_family_expansion")
        row["new_family_detected"] = "unexpected_family_expansion" in row["drift_signals"]
        row["platform_family"] = platform
    return {
        "hook_version": "marketplace_drift_v1",
        "platforms": sorted(platform_rows.values(), key=lambda item: item["platform_family"]),
    }


def build_summary(
    manifest: Dict[str, Any],
    cases: List[Dict[str, Any]],
    results: Dict[str, CaseResult],
    family_failures: List[Dict[str, Any]],
) -> Dict[str, Any]:
    case_failures = [failure for result in results.values() for failure in result.failures]
    failures = case_failures + family_failures
    by_severity: Dict[str, int] = {key: 0 for key in SEVERITY_ORDER}
    for failure in failures:
        by_severity[failure.get("failure_severity", DEFAULT_SEVERITY)] += 1
    by_platform: Dict[str, Dict[str, int]] = {}
    for result in results.values():
        row = by_platform.setdefault(result.platform_family, {"passed": 0, "failed": 0})
        row["passed" if result.passed else "failed"] += 1
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "parser_version": parser_version(),
        "manifest_metadata": manifest.get("metadata", {}),
        "trend_compatibility": {
            "trend_record_version": TREND_RECORD_VERSION,
            "compatible": True,
            "stable_keys": ["case_id", "platform_family", "kind", "severity", "field", "failure_type"],
        },
        "totals": {
            "case_count": len(cases),
            "passed_count": sum(1 for result in results.values() if result.passed),
            "failed_count": sum(1 for result in results.values() if not result.passed),
            "failure_count": len(failures),
        },
        "failure_severity": by_severity,
        "by_platform": by_platform,
        "failures": failures,
        "marketplace_drift_detection": marketplace_drift_hooks(cases, results),
    }


def run_manifest(
    manifest_path: Path,
    output_dir: Path,
    tiers: Iterable[str] | None = None,
    case_ids: Iterable[str] | None = None,
) -> Dict[str, Any]:
    root_dir = repo_root_from(manifest_path)
    manifest = load_json(manifest_path)
    errors = validate_manifest(manifest, root_dir=root_dir)
    if errors:
        raise ValueError("invalid regression manifest: " + "; ".join(errors))

    selected_cases = _filter_cases(
        manifest["cases"],
        set(tiers or []) or None,
        set(case_ids or []) or None,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    results = {
        case["case_id"]: run_case(case, root_dir, output_dir)
        for case in selected_cases
    }
    family_failures = validate_family_grouping(selected_cases, results)
    summary = build_summary(manifest, selected_cases, results, family_failures)
    report = {
        "summary": summary,
        "cases": [
            {
                "case_id": result.case_id,
                "platform_family": result.platform_family,
                "kind": result.kind,
                "severity": result.severity,
                "passed": result.passed,
                "template_family_id": result.template_family_id,
                "decisions": result.decisions,
                "trust_report": result.trust_report,
                "failures": result.failures,
            }
            for result in results.values()
        ],
    }
    write_json(output_dir / "audit-summary.json", summary)
    write_json(output_dir / "audit-report.json", report)
    write_json(output_dir / "family-groups.json", {
        result.case_id: {
            "platform_family": result.platform_family,
            "template_family_id": result.template_family_id,
        }
        for result in results.values()
    })
    write_json(output_dir / "trust-diff.json", {
        result.case_id: result.failures
        for result in results.values()
        if any(failure["failure_type"] == "trust_snapshot_diff" for failure in result.failures)
    })
    return report


def run_self_healing_scenario(scenario_path: Path, output_dir: Path) -> Dict[str, Any]:
    root_dir = repo_root_from(scenario_path)
    scenario = load_json(scenario_path)
    case_id = scenario["scenario_id"]
    with isolated_parser_paths(case_id, "empty", output_dir) as (learning_path, confidence_path, _report_dir):
        eml_path = root_dir / scenario["eml_path"]
        baseline = parse_eml(str(eml_path), update_confidence=False)
        family_id = baseline["template_family_id"]
        for record in scenario.get("seed_assignments", []):
            payload = {**record, "template_id": family_id}
            learning_store.save_record(payload)
        stale_parse = parse_eml(str(eml_path), update_confidence=False)
        selector = {**scenario["admin_selector"], "template_id": family_id, "dry_run": True}
        admin_paths = learning_admin.AdminPaths(
            learning_store_path=Path(learning_path),
            confidence_store_path=Path(confidence_path),
            audit_dir=output_dir / "audit",
            backup_dir=output_dir / "backups",
        )
        dry_run = learning_admin.apply(selector, paths=admin_paths)
        applied = learning_admin.apply({**selector, "dry_run": False}, paths=admin_paths)
        cleaned_parse = parse_eml(str(eml_path), update_confidence=False)
        restored = learning_admin.restore(applied["audit_id"], paths=admin_paths, dry_run=False)
        restored_parse = parse_eml(str(eml_path), update_confidence=False)

    result = {
        "scenario_id": case_id,
        "passed": True,
        "baseline_decisions": decisions_to_fields(baseline["decisions"]),
        "stale_decisions": decisions_to_fields(stale_parse["decisions"]),
        "cleaned_decisions": decisions_to_fields(cleaned_parse["decisions"]),
        "restored_decisions": decisions_to_fields(restored_parse["decisions"]),
        "dry_run": dry_run,
        "applied": {
            "audit_id": applied["audit_id"],
            "matched_count": applied["matched_count"],
            "mutation_preview_score": applied["mutation_preview_score"],
            "backups": applied["backups"],
        },
        "restored": {
            "matched_count": restored["matched_count"],
            "mutation_preview_score": restored["mutation_preview_score"],
        },
    }
    expected_field = scenario.get("expected_field", "quantity")
    expected_value = str(scenario.get("expected_value", ""))
    result["passed"] = (
        result["baseline_decisions"].get(expected_field) == expected_value
        and result["cleaned_decisions"].get(expected_field) == expected_value
        and result["restored_decisions"].get(expected_field) == result["stale_decisions"].get(expected_field)
        and dry_run["dry_run"] is True
        and applied["matched_count"] >= 1
        and restored["matched_count"] >= 1
    )
    write_json(output_dir / f"{case_id}.self-healing.json", result)
    return result


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run parser regression pack audit")
    parser.add_argument("--manifest", default="tests/regression_pack/manifest.json")
    parser.add_argument("--output-dir", default="parser/debug/regression_audit")
    parser.add_argument("--tier", action="append", default=[])
    parser.add_argument("--case-id", action="append", default=[])
    return parser


def main(argv: List[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    report = run_manifest(
        Path(args.manifest),
        Path(args.output_dir),
        tiers=args.tier or None,
        case_ids=args.case_id or None,
    )
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    return 0 if report["summary"]["totals"]["failed_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
