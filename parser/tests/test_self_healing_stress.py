from pathlib import Path

import pytest

from parser.regression_audit import run_self_healing_scenario


@pytest.mark.self_healing
def test_quantity_self_healing_scenario_uses_unlearn_restore(tmp_path):
    result = run_self_healing_scenario(
        Path("tests/regression_pack/scenarios/quantity_self_healing.json"),
        tmp_path / "self_healing",
    )

    assert result["passed"] is True
    assert result["dry_run"]["dry_run"] is True
    assert result["applied"]["matched_count"] >= 1
    assert result["applied"]["mutation_preview_score"] > 0
    assert result["applied"]["backups"]["learning_store"]
    assert result["restored"]["matched_count"] >= 1
    assert result["baseline_decisions"]["quantity"] == "1"
    assert result["cleaned_decisions"]["quantity"] == "1"
    assert result["restored_decisions"].get("quantity", "") == result["stale_decisions"].get("quantity", "")
