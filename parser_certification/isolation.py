from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Iterator

from parser import pipeline
from parser.learning import confidence_store
from parser.learning import store as learning_store

from .snapshots import file_sha256


@contextlib.contextmanager
def isolated_parser_runtime(root: Path) -> Iterator[dict[str, Path | dict[str, str]]]:
    """Run parser certification against temp stores only."""
    root.mkdir(parents=True, exist_ok=True)
    original_learning_path = learning_store.STORE_PATH
    original_confidence_path = confidence_store.CONFIDENCE_STORE_PATH
    original_report_dir = pipeline.TRUST_REPORT_DIR

    live_hashes_before = {
        "learning_store": file_sha256(original_learning_path),
        "confidence_store": file_sha256(original_confidence_path),
    }

    learning_path = root / "stores" / "learning_store.json"
    confidence_path = root / "stores" / "confidence_store.json"
    trust_report_dir = root / "trust_reports"
    learning_path.parent.mkdir(parents=True, exist_ok=True)
    learning_path.write_text("{}", encoding="utf-8")
    confidence_path.write_text("{}", encoding="utf-8")
    trust_report_dir.mkdir(parents=True, exist_ok=True)

    learning_store.STORE_PATH = str(learning_path)
    confidence_store.CONFIDENCE_STORE_PATH = str(confidence_path)
    pipeline.TRUST_REPORT_DIR = trust_report_dir
    try:
        yield {
            "learning_store_path": learning_path,
            "confidence_store_path": confidence_path,
            "trust_report_dir": trust_report_dir,
            "live_hashes_before": live_hashes_before,
        }
    finally:
        learning_store.STORE_PATH = original_learning_path
        confidence_store.CONFIDENCE_STORE_PATH = original_confidence_path
        pipeline.TRUST_REPORT_DIR = original_report_dir


def live_hashes() -> dict[str, str]:
    return {
        "learning_store": file_sha256(learning_store.STORE_PATH),
        "confidence_store": file_sha256(confidence_store.CONFIDENCE_STORE_PATH),
    }

