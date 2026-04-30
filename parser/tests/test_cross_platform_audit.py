from pathlib import Path

import pytest

from parser.regression_audit import load_json, run_manifest


MANIFEST_PATH = Path("tests/regression_pack/manifest.json")


@pytest.mark.cross_platform
def test_cross_platform_audit_covers_required_platforms(tmp_path):
    manifest = load_json(MANIFEST_PATH)
    report = run_manifest(MANIFEST_PATH, tmp_path / "audit", tiers={"regression"})
    observed_platforms = {
        case["platform_family"]
        for case in report["cases"]
    }

    assert report["summary"]["totals"]["failed_count"] == 0
    assert set(manifest["platform_coverage"]).issubset(observed_platforms)


@pytest.mark.cross_platform
def test_family_grouping_and_drift_hooks_are_reported(tmp_path):
    report = run_manifest(MANIFEST_PATH, tmp_path / "audit", tiers={"regression"})
    cases = {case["case_id"]: case for case in report["cases"]}
    drift = report["summary"]["marketplace_drift_detection"]

    assert report["summary"]["totals"]["failed_count"] == 0
    assert cases["marketflow_1001"]["template_family_id"] == cases["marketflow_1002"]["template_family_id"]
    assert cases["marketflow_1001"]["template_family_id"] != cases["shopify_like_5101"]["template_family_id"]
    assert all("platform_family" in row for row in drift["platforms"])
    assert all("observed_template_families" in row for row in drift["platforms"])
