import json

from server.inbox import inbox_service


def test_reconcile_source_deleted_marks_provider_missing_saved_uids(tmp_path, monkeypatch):
    inbox_dir = tmp_path / "Inbox"
    internal_dir = tmp_path / ".spaila_internal"
    inbox_dir.mkdir()
    internal_dir.mkdir()
    source_state_path = internal_dir / "inbox_source_state.json"

    (inbox_dir / "1700000000_101.eml").write_bytes(b"Subject: active\r\n\r\nactive")
    (inbox_dir / "1700000001_202.eml").write_bytes(b"Subject: missing\r\n\r\nmissing")
    source_state_path.write_text(json.dumps({"uids": {"101": False, "202": False}}), encoding="utf-8")

    monkeypatch.setattr(inbox_service, "_INBOX_DIR", inbox_dir)
    monkeypatch.setattr(inbox_service, "_INTERNAL_DIR", internal_dir)
    monkeypatch.setattr(inbox_service, "_SOURCE_STATE_PATH", source_state_path)

    result = inbox_service._reconcile_source_deleted({"101"})
    saved_state = json.loads(source_state_path.read_text(encoding="utf-8"))

    assert result == {
        "server_uid_count": 1,
        "local_uid_count": 2,
        "missing_count": 1,
        "restored_count": 0,
        "changed_count": 1,
    }
    assert saved_state["uids"] == {"101": False, "202": True}


def test_reconcile_source_deleted_marks_restored_provider_uids(tmp_path, monkeypatch):
    inbox_dir = tmp_path / "Inbox"
    internal_dir = tmp_path / ".spaila_internal"
    inbox_dir.mkdir()
    internal_dir.mkdir()
    source_state_path = internal_dir / "inbox_source_state.json"

    (inbox_dir / "1700000000_101.eml").write_bytes(b"Subject: restored\r\n\r\nrestored")
    source_state_path.write_text(json.dumps({"uids": {"101": True}}), encoding="utf-8")

    monkeypatch.setattr(inbox_service, "_INBOX_DIR", inbox_dir)
    monkeypatch.setattr(inbox_service, "_INTERNAL_DIR", internal_dir)
    monkeypatch.setattr(inbox_service, "_SOURCE_STATE_PATH", source_state_path)

    result = inbox_service._reconcile_source_deleted({"101"})
    saved_state = json.loads(source_state_path.read_text(encoding="utf-8"))

    assert result["restored_count"] == 1
    assert result["changed_count"] == 1
    assert saved_state["uids"] == {"101": False}
