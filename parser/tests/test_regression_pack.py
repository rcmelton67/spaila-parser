from pathlib import Path

import pytest

from parser.regression_audit import load_json, run_manifest, validate_manifest


MANIFEST_PATH = Path("tests/regression_pack/manifest.json")


@pytest.mark.regression_pack
def test_regression_manifest_schema_has_required_metadata():
    manifest = load_json(MANIFEST_PATH)

    assert validate_manifest(manifest, root_dir=Path.cwd()) == []
    assert manifest["metadata"]["parser_version"] == "0.1.0"
    assert manifest["metadata"]["trust_schema_version"] == 1
    assert set(manifest["metadata"]["field_model_versions"]) == {
        "order_number",
        "price",
        "shipping_address",
        "buyer_name",
        "quantity",
        "ship_by",
        "buyer_email",
        "order_date",
    }
    assert "critical" in manifest["metadata"]["severity_classification"]


@pytest.mark.regression_pack
def test_regression_pack_fast_tier_outputs_audit_reports(tmp_path):
    report = run_manifest(MANIFEST_PATH, tmp_path / "audit", tiers={"fast"})
    summary = report["summary"]

    assert summary["totals"]["failed_count"] == 0
    assert summary["trend_compatibility"]["compatible"] is True
    assert summary["marketplace_drift_detection"]["hook_version"] == "marketplace_drift_v1"
    assert (tmp_path / "audit" / "audit-summary.json").exists()
    assert (tmp_path / "audit" / "audit-report.json").exists()
    assert (tmp_path / "audit" / "family-groups.json").exists()
    assert (tmp_path / "audit" / "trust-diff.json").exists()


@pytest.mark.regression_pack
@pytest.mark.slow_audit
def test_regression_pack_audit_tier_is_green(tmp_path):
    report = run_manifest(MANIFEST_PATH, tmp_path / "audit", tiers={"audit"})

    assert report["summary"]["totals"]["failed_count"] == 0
    assert report["summary"]["totals"]["case_count"] >= 9


@pytest.mark.regression_pack
def test_regression_pack_trust_snapshot_normalization(tmp_path):
    report = run_manifest(
        MANIFEST_PATH,
        tmp_path / "audit",
        case_ids={"marketflow_1001", "unknown_contamination_9902"},
    )

    assert report["summary"]["totals"]["failed_count"] == 0
    for case in report["cases"]:
        normalized = case["trust_report"]
        assert "generated_at" not in normalized
        assert "artifact_path" not in normalized
        assert normalized["schema_version"] == 1
        assert normalized["fields"]["quantity"]["final_value"]
