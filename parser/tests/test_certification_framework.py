from pathlib import Path

from parser.learning import confidence_store, store as learning_store
from parser_certification.manifest import load_manifest
from parser_certification.runner import CertificationRunner
from parser_certification.snapshots import file_sha256


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "parser_certification" / "manifests" / "smoke.json"


def test_certification_manifest_schema_loads():
    manifest = load_manifest(MANIFEST)

    assert manifest.manifest_id == "standalone_parser_certification_smoke"
    assert len(manifest.cases) >= 2
    assert {case.tier for case in manifest.cases} >= {"smoke", "core"}


def test_certification_smoke_tier_uses_isolated_stores(tmp_path):
    learning_hash_before = file_sha256(learning_store.STORE_PATH)
    confidence_hash_before = file_sha256(confidence_store.CONFIDENCE_STORE_PATH)

    manifest = load_manifest(MANIFEST)
    report = CertificationRunner(tmp_path / "cert").run_manifest(manifest, tier="smoke")

    assert report.passed is True
    assert report.case_count == 2
    assert report.live_store_integrity is True
    assert file_sha256(learning_store.STORE_PATH) == learning_hash_before
    assert file_sha256(confidence_store.CONFIDENCE_STORE_PATH) == confidence_hash_before
    assert (tmp_path / "cert" / manifest.manifest_id / "smoke" / "certification-report.json").exists()

