import json

import pytest

from parser.learning import admin


def _admin_paths(tmp_path):
    learning_path = tmp_path / "learning_store.json"
    confidence_path = tmp_path / "confidence_store.json"
    learning_path.write_text(json.dumps({
        "family-1": [
            {
                "field": "quantity",
                "value": "1",
                "template_id": "family-1",
                "source": "source-a",
                "learned_signature": "number_regex|none|order_summary",
                "type": "assign",
                "active": True,
            },
            {
                "field": "quantity",
                "value": "1",
                "template_id": "family-1",
                "source": "source-a",
                "structural_signature": "quantity|number|summary",
                "type": "structural_trust",
                "trust_state": "promoted",
                "trust_score": 4.0,
                "positive_corrections": 4,
            },
        ]
    }), encoding="utf-8")
    confidence_path.write_text(json.dumps({
        "family-1|quantity|number_regex|none|order_summary": {
            "field": "quantity",
            "template_id": "family-1",
            "source": "source-a",
            "extraction_signature": "number_regex|none|order_summary",
            "streak": 4,
        }
    }), encoding="utf-8")
    return admin.AdminPaths(
        learning_store_path=learning_path,
        confidence_store_path=confidence_path,
        audit_dir=tmp_path / "audit",
        backup_dir=tmp_path / "backups",
    )


def test_admin_inspect_is_readonly_and_reports_preview_score(tmp_path):
    paths = _admin_paths(tmp_path)
    before = paths.learning_store_path.read_text(encoding="utf-8")

    result = admin.inspect({
        "operation": "inspect",
        "field": "quantity",
        "template_id": "family-1",
        "source": "source-a",
        "learned_signature": "number_regex|none|order_summary",
    }, paths=paths)

    assert result["dry_run"] is True
    assert result["scope_valid"] is True
    assert result["matched_count"] == 2
    assert 0 < result["mutation_preview_score"] <= 1
    assert paths.learning_store_path.read_text(encoding="utf-8") == before


def test_admin_remove_assignment_writes_audit_backup_and_restores(tmp_path):
    paths = _admin_paths(tmp_path)

    result = admin.apply({
        "operation": "remove_assignment",
        "field": "quantity",
        "template_id": "family-1",
        "source": "source-a",
        "learned_signature": "number_regex|none|order_summary",
        "reason": "stale assignment cleanup",
        "dry_run": False,
    }, paths=paths)

    learning = json.loads(paths.learning_store_path.read_text(encoding="utf-8"))
    assignment = learning["family-1"][0]
    assert result["status"] == "applied"
    assert result["matched_count"] == 1
    assert assignment["active"] is False
    assert assignment["quarantined"] is True
    assert assignment["admin_last_touched_at"]
    assert paths.audit_dir.joinpath("unlearn_restore.jsonl").exists()
    assert len(list(paths.backup_dir.glob("learning_store.*.json"))) == 1

    restored = admin.restore(result["audit_id"], paths=paths, dry_run=False)
    learning_after_restore = json.loads(paths.learning_store_path.read_text(encoding="utf-8"))

    assert restored["matched_count"] == 1
    assert learning_after_restore["family-1"][0]["active"] is True
    assert learning_after_restore["family-1"][0].get("quarantined", False) is False


def test_admin_quarantine_signature_removes_confidence_record(tmp_path):
    paths = _admin_paths(tmp_path)

    result = admin.apply({
        "operation": "quarantine_signature",
        "field": "quantity",
        "template_id": "family-1",
        "source": "source-a",
        "learned_signature": "number_regex|none|order_summary",
        "reason": "unsafe signature",
        "dry_run": False,
    }, paths=paths)

    learning = json.loads(paths.learning_store_path.read_text(encoding="utf-8"))
    confidence = json.loads(paths.confidence_store_path.read_text(encoding="utf-8"))

    assert result["matched_count"] == 2
    assert learning["family-1"][0]["quarantined"] is True
    assert confidence == {}


def test_admin_demote_trust_requires_structural_trust_record(tmp_path):
    paths = _admin_paths(tmp_path)

    result = admin.apply({
        "operation": "demote_trust",
        "field": "quantity",
        "template_id": "family-1",
        "source": "source-a",
        "structural_signature": "quantity|number|summary",
        "record_type": "structural_trust",
        "reason": "bad promoted structure",
        "dry_run": False,
    }, paths=paths)

    trust = json.loads(paths.learning_store_path.read_text(encoding="utf-8"))["family-1"][1]

    assert result["matched_count"] == 1
    assert trust["trust_state"] == "demoted"
    assert trust["negative_corrections"] == 1
    assert trust["trust_score"] <= -1.0


def test_admin_mutation_rejects_global_field_only_scope(tmp_path):
    paths = _admin_paths(tmp_path)

    with pytest.raises(ValueError, match="mutation requires field"):
        admin.apply({
            "operation": "reset_field",
            "field": "quantity",
            "dry_run": False,
        }, paths=paths)
