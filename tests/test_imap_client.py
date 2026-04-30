from server.inbox import imap_client
import pytest


class FakeImapClient:
    def __init__(self):
        self.commands = []
        self.selected = ""

    def login(self, username, password):
        self.commands.append(("login", username, password))
        return "OK", []

    def list(self):
        self.commands.append(("list",))
        return "OK", [b'(\\HasNoChildren) "/" "Deleted Items"']

    def select(self, mailbox, readonly=False):
        self.commands.append(("select", mailbox, readonly))
        self.selected = mailbox
        return "OK", []

    def uid(self, command, *args):
        self.commands.append(("uid", command, *args))
        if command.lower() == "move":
            return "OK", []
        return "NO", []

    def close(self):
        self.commands.append(("close",))
        return "OK", []

    def logout(self):
        self.commands.append(("logout",))
        return "OK", []


class CopyDeleteImapClient(FakeImapClient):
    def uid(self, command, *args):
        self.commands.append(("uid", command, *args))
        lowered = command.lower()
        if lowered == "move":
            return "NO", []
        if lowered == "copy":
            return "OK", []
        if lowered == "store":
            return "OK", []
        return "NO", []

    def expunge(self):
        self.commands.append(("expunge",))
        return "OK", []


class NoTrashImapClient(CopyDeleteImapClient):
    def list(self):
        self.commands.append(("list",))
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"']


class SearchCaptureImapClient(FakeImapClient):
    def uid(self, command, *args):
        self.commands.append(("uid", command, *args))
        lowered = command.lower()
        if lowered == "search":
            return "OK", [b""]
        return "NO", []


def test_move_message_to_trash_uses_provider_trash_folder(monkeypatch):
    client = FakeImapClient()
    monkeypatch.setattr(imap_client, "_connect", lambda *args, **kwargs: client)

    result = imap_client.move_message_to_trash(
        host="outlook.office365.com",
        username="seller@example.com",
        password="secret",
        email_id="123",
    )

    assert result == {"status": "ok", "method": "move", "trash_mailbox": "Deleted Items"}
    assert ("uid", "MOVE", "123", '"Deleted Items"') in client.commands


def test_move_message_to_trash_falls_back_to_copy_then_expunge_source(monkeypatch):
    client = CopyDeleteImapClient()
    monkeypatch.setattr(imap_client, "_connect", lambda *args, **kwargs: client)

    result = imap_client.move_message_to_trash(
        host="imap.example.com",
        username="seller@example.com",
        password="secret",
        email_id="123",
    )

    assert result == {"status": "ok", "method": "copy_expunge_source", "trash_mailbox": "Deleted Items"}
    assert ("uid", "COPY", "123", '"Deleted Items"') in client.commands
    assert ("uid", "store", "123", "+FLAGS", r"(\Deleted)") in client.commands
    assert ("expunge",) in client.commands


def test_move_message_to_trash_fails_when_trash_folder_missing(monkeypatch):
    client = NoTrashImapClient()
    monkeypatch.setattr(imap_client, "_connect", lambda *args, **kwargs: client)

    with pytest.raises(RuntimeError, match="Provider Trash folder"):
        imap_client.move_message_to_trash(
            host="imap.example.com",
            username="seller@example.com",
            password="secret",
            email_id="123",
        )

    assert ("uid", "store", "123", "+FLAGS", r"(\Deleted)") not in client.commands
    assert ("expunge",) not in client.commands


def test_unquoted_multiword_trash_folder_is_parsed():
    row = b'(\\HasNoChildren) "/" Deleted Items'

    assert imap_client._decode_mailbox_list_name(row) == "Deleted Items"


def test_special_use_trash_folder_is_preferred(monkeypatch):
    client = FakeImapClient()

    def fake_list():
        client.commands.append(("list",))
        return "OK", [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\HasNoChildren \\Trash) "/" "Archive/Deleted"',
        ]

    client.list = fake_list
    monkeypatch.setattr(imap_client, "_connect", lambda *args, **kwargs: client)

    result = imap_client.move_message_to_trash(
        host="imap.example.com",
        username="seller@example.com",
        password="secret",
        email_id="123",
    )

    assert result == {"status": "ok", "method": "move", "trash_mailbox": "Archive/Deleted"}
    assert ("uid", "MOVE", "123", "Archive/Deleted") in client.commands


def test_inbox_uid_listing_excludes_soft_deleted_messages(monkeypatch):
    client = SearchCaptureImapClient()
    monkeypatch.setattr(imap_client, "_connect", lambda *args, **kwargs: client)

    result = imap_client.list_message_uids(
        host="imap.example.com",
        username="seller@example.com",
        password="secret",
    )

    assert result == set()
    assert ("uid", "search", None, "UNDELETED") in client.commands
