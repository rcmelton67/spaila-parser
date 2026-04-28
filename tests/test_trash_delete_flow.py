import pytest
from fastapi import HTTPException

from server.inbox import inbox_routes


def test_delete_inbox_marks_source_deleted_on_success(monkeypatch):
    calls = []

    def fake_delete(email_id):
        calls.append(("delete", email_id))

    def fake_mark(email_id, deleted):
        calls.append(("mark", email_id, deleted))

    monkeypatch.setattr(inbox_routes.mail_service, "delete_email", fake_delete)
    monkeypatch.setattr(inbox_routes, "mark_source_deleted", fake_mark)

    result = inbox_routes._delete_inbox_email_by_id("123")

    assert result == {"status": "ok", "source_deleted": True}
    assert calls == [("delete", "123"), ("mark", "123", True)]


def test_delete_inbox_marks_source_not_deleted_on_failure(monkeypatch):
    calls = []

    def fake_delete(email_id):
        calls.append(("delete", email_id))
        raise RuntimeError("provider failed")

    def fake_mark(email_id, deleted):
        calls.append(("mark", email_id, deleted))

    monkeypatch.setattr(inbox_routes.mail_service, "delete_email", fake_delete)
    monkeypatch.setattr(inbox_routes, "mark_source_deleted", fake_mark)

    with pytest.raises(HTTPException) as exc:
        inbox_routes._delete_inbox_email_by_id("123")

    assert exc.value.status_code == 500
    assert calls == [("delete", "123"), ("mark", "123", False)]


def test_delete_inbox_not_found_counts_as_source_deleted(monkeypatch):
    calls = []

    def fake_delete(email_id):
        calls.append(("delete", email_id))
        raise RuntimeError("Email was not found in the mailbox.")

    def fake_mark(email_id, deleted):
        calls.append(("mark", email_id, deleted))

    monkeypatch.setattr(inbox_routes.mail_service, "delete_email", fake_delete)
    monkeypatch.setattr(inbox_routes, "mark_source_deleted", fake_mark)

    result = inbox_routes._delete_inbox_email_by_id("123")

    assert result == {"status": "ok"}
    assert calls == [("delete", "123"), ("mark", "123", True)]
