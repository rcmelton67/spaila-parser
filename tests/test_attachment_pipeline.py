import json
import sqlite3
from email.message import EmailMessage
from pathlib import Path

from backend.orders import _normalize_message_attachments, _restore_message_attachment_paths
from server.inbox import attachments as attachment_store
from server.inbox import email_archive
from server.inbox.inbox_service import _persist_inbound_to_order_thread


def _raw_email_with_attachment(*, subject="Order 12345", body="See attached.") -> bytes:
    msg = EmailMessage()
    msg["From"] = "Customer <customer@example.com>"
    msg["To"] = "shop@example.com"
    msg["Subject"] = subject
    msg["Message-ID"] = "<attachment-test@example.com>"
    msg["Date"] = "Tue, 28 Apr 2026 12:00:00 -0500"
    if body is not None:
        msg.set_content(body)
    else:
        msg.set_content("")
    msg.add_attachment(
        b"fake image bytes",
        maintype="image",
        subtype="png",
        filename="preview.png",
    )
    return msg.as_bytes()


def _raw_order_email(*, order_number: str, message_id: str, subject: str | None = None) -> bytes:
    msg = EmailMessage()
    msg["From"] = "Etsy <transaction@etsy.com>"
    msg["To"] = "shop@example.com"
    msg["Subject"] = subject or f"You made a sale on Etsy - Ship by May 8 - [$67.84, Order #{order_number}]"
    msg["Message-ID"] = f"<{message_id}>"
    msg["Date"] = "Fri, 01 May 2026 14:38:29 +0000"
    msg.set_content(f"New order: #{order_number}\nOrder #{order_number}\nShip by: May 8")
    return msg.as_bytes()


def test_extract_and_store_attachments_writes_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(attachment_store, "_ATTACHMENT_ROOT", tmp_path / "attachments")
    raw = _raw_email_with_attachment()
    parsed = EmailMessage()
    from email.parser import BytesParser
    from email.policy import default

    parsed = BytesParser(policy=default).parsebytes(raw)

    attachments = attachment_store.extract_and_store_attachments(
        parsed,
        raw_mime=raw,
        email_id="42",
        message_id="attachment-test@example.com",
        source_eml_path=str(tmp_path / "message.eml"),
        timestamp="2026-04-28T12:00:00-05:00",
    )

    assert len(attachments) == 1
    assert attachments[0]["filename"] == "preview.png"
    assert attachments[0]["mime_type"] == "image/png"
    assert Path(attachments[0]["path"]).is_file()


def test_attachment_only_email_can_link_to_order(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(attachment_store, "_ATTACHMENT_ROOT", tmp_path / "attachments")
    monkeypatch.setattr(email_archive, "_INTERNAL_DIR", tmp_path / ".spaila_internal")
    monkeypatch.setattr(email_archive, "_EMAIL_ARCHIVE_DIR", tmp_path / ".spaila_internal" / "email_archive")
    monkeypatch.setattr(email_archive, "_RETENTION_INDEX_PATH", tmp_path / ".spaila_internal" / "email_retention_index.json")
    conn = sqlite3.connect("spaila.db")
    conn.execute(
        """
        CREATE TABLE orders (
            id TEXT,
            order_number TEXT,
            buyer_name TEXT,
            buyer_email TEXT,
            messages TEXT,
            source_eml_path TEXT,
            eml_path TEXT,
            created_at TEXT,
            order_date TEXT,
            last_activity_at TEXT,
            status TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE inbox_events (
            id TEXT,
            type TEXT,
            order_id TEXT,
            order_number TEXT,
            buyer_name TEXT,
            preview TEXT,
            timestamp TEXT,
            unread INTEGER,
            created_at TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "order-1",
            "12345",
            "Customer",
            "customer@example.com",
            "[]",
            "",
            "",
            "2026-04-27T12:00:00+00:00",
            "2026-04-27",
            "2026-04-27T12:00:00+00:00",
            "active",
        ),
    )
    conn.commit()
    conn.close()

    result = _persist_inbound_to_order_thread(_raw_email_with_attachment(body=None), "42")

    assert result["matched"] is True
    assert result["appended"] is True
    conn = sqlite3.connect("spaila.db")
    row = conn.execute("SELECT messages FROM orders WHERE id = 'order-1'").fetchone()
    messages = json.loads(row[0])
    conn.close()
    assert messages[0]["attachments"][0]["filename"] == "preview.png"
    assert messages[0]["body"].startswith("[Attachment email:")
    assert str(messages[0]["attachments"][0]["sourcePath"]).startswith(str(tmp_path / ".spaila_internal" / "email_archive"))
    retention = json.loads((tmp_path / ".spaila_internal" / "email_retention_index.json").read_text(encoding="utf-8"))
    record = next(iter(retention["records"].values()))
    assert record["linked_order_id"] == "order-1"
    assert record["status"] == "processed_archived"


def test_new_order_email_with_different_order_number_does_not_attach_to_recent_order(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(attachment_store, "_ATTACHMENT_ROOT", tmp_path / "attachments")
    monkeypatch.setattr(email_archive, "_INTERNAL_DIR", tmp_path / ".spaila_internal")
    monkeypatch.setattr(email_archive, "_EMAIL_ARCHIVE_DIR", tmp_path / ".spaila_internal" / "email_archive")
    monkeypatch.setattr(email_archive, "_RETENTION_INDEX_PATH", tmp_path / ".spaila_internal" / "email_retention_index.json")
    conn = sqlite3.connect("spaila.db")
    conn.execute(
        """
        CREATE TABLE orders (
            id TEXT,
            order_number TEXT,
            buyer_name TEXT,
            buyer_email TEXT,
            messages TEXT,
            source_eml_path TEXT,
            eml_path TEXT,
            created_at TEXT,
            order_date TEXT,
            last_activity_at TEXT,
            status TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE inbox_events (
            id TEXT,
            type TEXT,
            order_id TEXT,
            order_number TEXT,
            buyer_name TEXT,
            preview TEXT,
            timestamp TEXT,
            unread INTEGER,
            created_at TEXT
        )
        """
    )
    existing_subject = "You made a sale on Etsy - Ship by May 8 - [$67.84, Order #4038405186]"
    conn.execute(
        "INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "order-1",
            "4038405186",
            "Logan Kistler",
            "",
            json.dumps([{"subject": existing_subject, "message_id": "old@example.com"}]),
            "",
            "",
            "2026-05-01T13:00:00+00:00",
            "2026-05-01",
            "2026-05-01T13:00:00+00:00",
            "active",
        ),
    )
    conn.commit()
    conn.close()

    result = _persist_inbound_to_order_thread(
        _raw_order_email(order_number="4044385386", message_id="new@example.com"),
        "42300",
    )

    assert result["matched"] is False
    assert result["reason"] == "no_order_match"
    conn = sqlite3.connect("spaila.db")
    row = conn.execute("SELECT messages FROM orders WHERE id = 'order-1'").fetchone()
    messages = json.loads(row[0])
    conn.close()
    assert len(messages) == 1


def test_archive_attachment_metadata_is_restore_safe(tmp_path):
    source = tmp_path / "proof.png"
    source.write_bytes(b"proof")
    normalized = _normalize_message_attachments([str(source)])

    assert normalized[0]["file"] == "proof.png"
    assert normalized[0]["original_path"] == str(source)

    order_folder = tmp_path / "order"
    order_folder.mkdir()
    restored_file = order_folder / "proof.png"
    restored_file.write_bytes(b"proof")
    restored = _restore_message_attachment_paths(
        [{"body": "sent", "attachments": [{"file": "proof.png", "path": "proof.png"}]}],
        order_folder,
    )

    assert restored[0]["attachments"][0]["path"] == str(restored_file.resolve())
