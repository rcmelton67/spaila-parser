import hashlib
import json
from email.message import EmailMessage
from pathlib import Path

from server.inbox import email_archive


def _raw_email(*, message_id="<retention@example.com>", subject="Order 1001") -> bytes:
    msg = EmailMessage()
    msg["From"] = "Customer <customer@example.com>"
    msg["To"] = "shop@example.com"
    msg["Subject"] = subject
    msg["Message-ID"] = message_id
    msg["Date"] = "Tue, 28 Apr 2026 12:00:00 -0500"
    msg.set_content("New order: #1001")
    return msg.as_bytes()


def _isolated_archive(monkeypatch, tmp_path):
    internal = tmp_path / ".spaila_internal"
    monkeypatch.setattr(email_archive, "_INTERNAL_DIR", internal)
    monkeypatch.setattr(email_archive, "_EMAIL_ARCHIVE_DIR", internal / "email_archive")
    monkeypatch.setattr(email_archive, "_INACTIVE_INBOX_DIR", internal / "inbox_inactive")
    monkeypatch.setattr(email_archive, "_RETENTION_INDEX_PATH", internal / "email_retention_index.json")


def test_archive_raw_email_preserves_verified_recovery_copy(tmp_path, monkeypatch):
    _isolated_archive(monkeypatch, tmp_path)
    raw = _raw_email()

    record = email_archive.archive_raw_email(
        raw,
        email_id="101",
        uid="101",
        message_id="retention@example.com",
        original_inbox_path=str(tmp_path / "inbox" / "message.eml"),
        status="processed",
    )

    archive_path = Path(record["archive_path"])
    assert archive_path.is_file()
    assert archive_path.read_bytes() == raw
    assert record["checksum"] == hashlib.sha256(raw).hexdigest()
    assert record["verified"] is True
    index = json.loads((tmp_path / ".spaila_internal" / "email_retention_index.json").read_text(encoding="utf-8"))
    assert index["records"]["message:retention@example.com"]["archive_path"] == str(archive_path)


def test_retention_update_links_order_without_replaying_raw_value(tmp_path, monkeypatch):
    _isolated_archive(monkeypatch, tmp_path)
    raw = _raw_email()
    email_archive.archive_raw_email(raw, email_id="101", message_id="retention@example.com", status="active")

    updated = email_archive.update_retention_record(
        email_id="101",
        message_id="retention@example.com",
        linked_order_id="order-1",
        linked_conversation_id="message-1",
        status="processed_archived",
    )

    assert updated["linked_order_id"] == "order-1"
    assert updated["linked_conversation_id"] == "message-1"
    assert updated["status"] == "processed_archived"


def test_processed_migration_copies_without_removing_active_inbox_file(tmp_path, monkeypatch):
    _isolated_archive(monkeypatch, tmp_path)
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    source = inbox / "1700000000_101.eml"
    source.write_bytes(_raw_email(message_id="<migrate@example.com>"))

    result = email_archive.migrate_processed_inbox_files(
        inbox,
        {str(source), source.name},
        dry_run=False,
    )

    assert result["copied"] == 1
    assert source.is_file()
    archived = Path(result["items"][0]["archive_path"])
    assert archived.is_file()
    assert archived.read_bytes() == source.read_bytes()


def test_sync_active_inbox_lifecycle_moves_hidden_file_after_archive(tmp_path, monkeypatch):
    _isolated_archive(monkeypatch, tmp_path)
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    source = inbox / "1700000000_101.eml"
    source.write_bytes(_raw_email(message_id="<hidden@example.com>"))

    result = email_archive.sync_active_inbox_lifecycle(
        inbox,
        hidden_ids={"101", "hidden@example.com"},
    )

    assert result["moved"] == 1
    assert not source.exists()
    item = result["items"][0]
    assert Path(item["inactive_path"]).is_file()
    assert Path(item["archive_path"]).is_file()
    assert Path(item["archive_path"]).read_bytes() == Path(item["inactive_path"]).read_bytes()


def test_sync_active_inbox_lifecycle_keeps_unmatched_active_file(tmp_path, monkeypatch):
    _isolated_archive(monkeypatch, tmp_path)
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    source = inbox / "1700000000_101.eml"
    source.write_bytes(_raw_email(message_id="<active@example.com>"))

    result = email_archive.sync_active_inbox_lifecycle(inbox)

    assert result["moved"] == 0
    assert result["kept"] == 1
    assert source.is_file()
