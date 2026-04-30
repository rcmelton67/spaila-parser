import pytest
import shutil

from parser import pipeline
from parser.learning import confidence_store
from parser.learning import store as learning_store


@pytest.fixture(autouse=True)
def isolated_parser_runtime(tmp_path, monkeypatch, request):
    monkeypatch.setattr(pipeline, "TRUST_REPORT_DIR", tmp_path / "trust_reports")
    learning_store_path = tmp_path / "learning_store.json"
    confidence_store_path = tmp_path / "confidence_store.json"
    if request.node.fspath.basename in {
        "test_regression_parser.py",
        "test_regression_pack.py",
        "test_cross_platform_audit.py",
    }:
        shutil.copyfile(learning_store.STORE_PATH, learning_store_path)
        shutil.copyfile(confidence_store.CONFIDENCE_STORE_PATH, confidence_store_path)
    else:
        learning_store_path.write_text("{}", encoding="utf-8")
        confidence_store_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(learning_store, "STORE_PATH", str(learning_store_path))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(confidence_store_path))
