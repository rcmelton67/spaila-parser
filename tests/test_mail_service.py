import threading
import time

from server.inbox.mail_service import MailService, clamp_poll_interval


def _settings(**overrides):
    data = {
        "imapHost": "imap.example.com",
        "imapUsername": "seller@example.com",
        "imapPassword": "secret",
        "imapPort": "993",
        "imapUseSsl": True,
        "imapFetchLimit": "20",
        "mailPollingIntervalSeconds": 300,
        "mailBackgroundSyncEnabled": True,
        "mailStartupAutoConnect": True,
        "mailReconnectEnabled": True,
    }
    data.update(overrides)
    return data


def test_poll_lock_skips_overlapping_fetches():
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def fetcher(**kwargs):
        calls.append(kwargs)
        entered.set()
        release.wait(timeout=2)
        return {"saved": 1, "skipped": 0, "fetched": 1, "last_seen_uid": 10}

    service = MailService(
        settings_loader=lambda: _settings(),
        fetcher=fetcher,
        checker=lambda **_: True,
        sleeper=lambda _: None,
    )

    first = threading.Thread(target=lambda: service.poll(force=True, reason="first"))
    first.start()
    assert entered.wait(timeout=1)

    skipped = service.poll(force=True, reason="second")
    release.set()
    first.join(timeout=2)

    assert skipped["skip_reason"] == "in_flight"
    assert len(calls) == 1


def test_manual_fetch_forces_poll_and_returns_payload():
    calls = []

    def fetcher(**kwargs):
        calls.append(kwargs)
        return {
            "saved": 2,
            "skipped": 3,
            "fetched": 5,
            "last_seen_uid": 42,
            "source_deleted_missing": 1,
            "source_deleted_changed": 1,
        }

    service = MailService(
        settings_loader=lambda: _settings(),
        fetcher=fetcher,
        checker=lambda **_: True,
    )

    result = service.poll(force=True, reason="manual_fetch")

    assert result == {
        "status": "ok",
        "saved": 2,
        "skipped": 3,
        "fetched": 5,
        "last_seen_uid": 42,
        "source_deleted_missing": 1,
        "source_deleted_changed": 1,
    }
    assert calls[0]["resync"] is False


def test_status_does_not_perform_imap_login():
    calls = {"check": 0}

    def checker(**kwargs):
        calls["check"] += 1
        return True

    service = MailService(
        settings_loader=lambda: _settings(),
        checker=checker,
    )

    status = service.status()

    assert status["configured"] is True
    assert calls["check"] == 0


def test_disabled_background_sync_does_not_start_worker_thread():
    service = MailService(
        settings_loader=lambda: _settings(mailBackgroundSyncEnabled=False),
        checker=lambda **_: True,
    )

    status = service.start(auto=True)

    assert status["running"] is True
    assert status["background_sync_enabled"] is False
    assert service._thread is None
    service.stop(reason="test")


def test_auto_start_fetches_immediately_before_waiting_for_interval():
    calls = []

    def fetcher(**kwargs):
        calls.append(kwargs)
        return {"saved": 1, "skipped": 0, "fetched": 1, "last_seen_uid": 10}

    service = MailService(
        settings_loader=lambda: _settings(mailPollingIntervalSeconds=300),
        fetcher=fetcher,
        checker=lambda **_: True,
        sleeper=lambda _: None,
    )

    status = service.start(auto=True)

    assert status["last_reason"] == "startup"
    assert calls
    assert calls[0]["resync"] is False
    service.stop(reason="test")


def test_poll_interval_is_clamped_to_safe_bounds():
    assert clamp_poll_interval(5) == 60
    assert clamp_poll_interval(7200) == 3600
    assert clamp_poll_interval("bad") == 300


def test_move_email_to_trash_uses_configured_mailbox_and_provider_result():
    calls = []

    def trasher(**kwargs):
        calls.append(kwargs)
        return {"status": "ok", "trash_mailbox": "Deleted Items", "method": "move"}

    service = MailService(
        settings_loader=lambda: _settings(imapMailbox="INBOX"),
        checker=lambda **_: True,
        trasher=trasher,
    )
    service.connect(reason="test")

    result = service.move_email_to_trash("123")

    assert result == {"status": "ok", "trash_mailbox": "Deleted Items", "method": "move"}
    assert calls[0]["email_id"] == "123"
    assert calls[0]["mailbox"] == "INBOX"


def test_delete_email_can_target_provider_trash_mailbox():
    calls = []

    def deleter(**kwargs):
        calls.append(kwargs)

    service = MailService(
        settings_loader=lambda: _settings(),
        checker=lambda **_: True,
        deleter=deleter,
    )
    service.connect(reason="test")

    result = service.delete_email("message@example.com", mailbox="Deleted Items")

    assert result == {"status": "ok"}
    assert calls[0]["email_id"] == "message@example.com"
    assert calls[0]["mailbox"] == "Deleted Items"
