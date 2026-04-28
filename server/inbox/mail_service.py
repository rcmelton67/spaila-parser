from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict

from workspace_paths import get_workspace_root

from .imap_client import check_imap_connection, delete_message
from .inbox_service import fetch_and_store_emails


DEFAULT_POLL_INTERVAL_SECONDS = 300
MIN_POLL_INTERVAL_SECONDS = 60
MAX_POLL_INTERVAL_SECONDS = 3600


def _bool_setting(settings: dict, key: str, default: bool) -> bool:
    if key not in settings:
        return default
    value = settings.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def _int_setting(settings: dict, key: str, default: int) -> int:
    try:
        return int(str(settings.get(key, default)).strip())
    except Exception:
        return default


def clamp_poll_interval(value: Any) -> int:
    try:
        parsed = int(str(value).strip())
    except Exception:
        parsed = DEFAULT_POLL_INTERVAL_SECONDS
    return max(MIN_POLL_INTERVAL_SECONDS, min(MAX_POLL_INTERVAL_SECONDS, parsed))


def load_email_settings() -> dict:
    settings_path = Path(get_workspace_root()) / "email_settings.json"
    if not settings_path.is_file():
        raise ValueError("Email settings have not been saved yet.")
    try:
        return json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise ValueError(f"Could not read email settings: {error}") from error


@dataclass(frozen=True)
class MailSettings:
    host: str
    username: str
    password: str
    mailbox: str
    limit: int
    port: int
    use_ssl: bool
    poll_interval_seconds: int
    background_sync_enabled: bool
    startup_auto_connect: bool
    reconnect_enabled: bool

    @property
    def configured(self) -> bool:
        return bool(self.host and self.username and self.password)

    @classmethod
    def from_raw(cls, settings: dict) -> "MailSettings":
        return cls(
            host=str(settings.get("imapHost") or settings.get("imap_host") or "").strip(),
            username=str(settings.get("imapUsername") or settings.get("imap_user") or "").strip(),
            password=str(settings.get("imapPassword") or settings.get("imap_pass") or ""),
            mailbox=str(settings.get("imapMailbox") or settings.get("imap_mailbox") or "INBOX").strip() or "INBOX",
            limit=max(1, min(_int_setting(settings, "imapFetchLimit", 20), 500)),
            port=_int_setting(settings, "imapPort", _int_setting(settings, "imap_port", 993)),
            use_ssl=_bool_setting(settings, "imapUseSsl", _bool_setting(settings, "imap_ssl", True)),
            poll_interval_seconds=clamp_poll_interval(settings.get("mailPollingIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS)),
            background_sync_enabled=_bool_setting(settings, "mailBackgroundSyncEnabled", True),
            startup_auto_connect=_bool_setting(settings, "mailStartupAutoConnect", True),
            reconnect_enabled=_bool_setting(settings, "mailReconnectEnabled", True),
        )


class MailService:
    """Application-level owner for inbox sync and IMAP health.

    The lower-level IMAP helpers still open short-lived sockets for individual
    operations. This service makes the app lifecycle persistent: one backend
    singleton owns polling, status, reconnect decisions, and operation locks.
    """

    def __init__(
        self,
        *,
        settings_loader: Callable[[], dict] = load_email_settings,
        fetcher: Callable[..., Dict[str, object]] = fetch_and_store_emails,
        checker: Callable[..., bool] = check_imap_connection,
        deleter: Callable[..., None] = delete_message,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._settings_loader = settings_loader
        self._fetcher = fetcher
        self._checker = checker
        self._deleter = deleter
        self._sleeper = sleeper
        self._state_lock = threading.RLock()
        self._operation_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._connected = False
        self._configured = False
        self._in_flight = False
        self._last_error = ""
        self._last_poll_at = 0.0
        self._last_success_at = 0.0
        self._last_result: Dict[str, object] = {}
        self._last_reason = ""

    def start(self, *, auto: bool = False) -> Dict[str, object]:
        settings = self._load_settings()
        if auto and not settings.startup_auto_connect:
            self._log("[MAIL_SERVICE_START]", {"started": False, "reason": "startup_auto_connect_disabled"})
            return self.status()

        with self._state_lock:
            if self._running:
                return self.status()
            self._running = True
            self._stop_event.clear()
            self._configured = settings.configured

        self._log("[MAIL_SERVICE_START]", {
            "configured": settings.configured,
            "background_sync_enabled": settings.background_sync_enabled,
            "poll_interval_seconds": settings.poll_interval_seconds,
        })

        if settings.configured:
            self.connect(reason="startup" if auto else "manual_start")

        if settings.background_sync_enabled and settings.configured:
            self._ensure_thread()
        return self.status()

    def stop(self, *, reason: str = "manual") -> Dict[str, object]:
        with self._state_lock:
            was_running = self._running
            self._running = False
            self._connected = False
            self._stop_event.set()
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        with self._state_lock:
            self._thread = None
        self._log("[MAIL_SERVICE_STOP]", {"reason": reason, "was_running": was_running})
        return self.status()

    def disconnect(self, *, reason: str = "manual_disconnect") -> Dict[str, object]:
        return self.stop(reason=reason)

    def reconnect(self, *, reason: str = "manual_reconnect") -> Dict[str, object]:
        self._log("[MAIL_SERVICE_RECONNECT]", {"reason": reason})
        self.stop(reason="reconnect")
        return self.start(auto=False)

    def connect(self, *, reason: str = "connect") -> bool:
        settings = self._load_settings()
        if not settings.configured:
            with self._state_lock:
                self._configured = False
                self._connected = False
                self._last_error = "Email settings have not been saved yet."
            return False

        try:
            connected = bool(self._checker(
                host=settings.host,
                username=settings.username,
                password=settings.password,
                mailbox=settings.mailbox,
                port=settings.port,
                use_ssl=settings.use_ssl,
                timeout=2.5,
            ))
        except Exception as error:
            connected = False
            with self._state_lock:
                self._last_error = str(error) or "Email connection unavailable."

        with self._state_lock:
            self._configured = True
            self._connected = connected
            if connected:
                self._last_error = ""
            elif not self._last_error:
                self._last_error = "Email connection unavailable."
        if not connected and settings.reconnect_enabled:
            self._log("[MAIL_SERVICE_RECONNECT]", {"reason": reason, "connected": False})
        return connected

    def poll(
        self,
        *,
        force: bool = False,
        resync: bool = False,
        reason: str = "background",
        limit: int | None = None,
    ) -> Dict[str, object]:
        settings = self._load_settings()
        with self._state_lock:
            self._configured = settings.configured
        if not settings.configured:
            return self._empty_result(error="Email settings have not been saved yet.")

        now = time.time()
        if not force and now - self._last_poll_at < settings.poll_interval_seconds:
            return {
                **self._last_result,
                "status": "ok",
                "skipped": self._last_result.get("skipped", 0),
                "skip_reason": "interval",
                "next_poll_in_seconds": int(settings.poll_interval_seconds - (now - self._last_poll_at)),
            }

        if not self._operation_lock.acquire(blocking=False):
            self._log("[MAIL_SERVICE_SKIP_INFLIGHT]", {"reason": reason})
            return {
                **self._last_result,
                "status": "ok",
                "skipped": self._last_result.get("skipped", 0),
                "skip_reason": "in_flight",
            }

        with self._state_lock:
            self._in_flight = True
        try:
            self._log("[MAIL_SERVICE_POLL]", {"reason": reason, "force": force, "resync": resync})
            result = self._fetcher(
                host=settings.host,
                username=settings.username,
                password=settings.password,
                mailbox=settings.mailbox,
                limit=limit or settings.limit,
                port=settings.port,
                use_ssl=settings.use_ssl,
                resync=resync,
            )
            normalized = {
                "status": "ok",
                "saved": result.get("saved", 0),
                "skipped": result.get("skipped", 0),
                "fetched": result.get("fetched", 0),
                "last_seen_uid": result.get("last_seen_uid", 0),
            }
            with self._state_lock:
                self._connected = True
                self._last_error = ""
                self._last_poll_at = time.time()
                self._last_success_at = self._last_poll_at
                self._last_result = normalized
                self._last_reason = reason
            return normalized
        except Exception as error:
            message = str(error) or "Could not fetch inbox emails."
            with self._state_lock:
                self._connected = False
                self._last_error = message
                self._last_poll_at = time.time()
            if settings.reconnect_enabled:
                self._log("[MAIL_SERVICE_RECONNECT]", {"reason": "poll_error", "error": message})
            raise
        finally:
            with self._state_lock:
                self._in_flight = False
            self._operation_lock.release()

    def delete_email(self, email_id: str) -> Dict[str, object]:
        settings = self._load_settings()
        if not settings.configured:
            raise ValueError("Email settings have not been saved yet.")
        if not self._operation_lock.acquire(timeout=20.0):
            self._log("[MAIL_SERVICE_SKIP_INFLIGHT]", {"reason": "delete"})
            raise RuntimeError("Mail service is busy. Try again shortly.")
        with self._state_lock:
            self._in_flight = True
        try:
            if not self._connected:
                self.connect(reason="delete")
            if not self._connected:
                raise RuntimeError("Email connection unavailable. Cannot delete from account.")
            self._deleter(
                host=settings.host,
                username=settings.username,
                password=settings.password,
                email_id=str(email_id or "").strip(),
                mailbox=settings.mailbox,
                port=settings.port,
                use_ssl=settings.use_ssl,
                timeout=2.5,
            )
            return {"status": "ok"}
        finally:
            with self._state_lock:
                self._in_flight = False
            self._operation_lock.release()

    def status(self) -> Dict[str, object]:
        settings = self._load_settings(raise_errors=False)
        with self._state_lock:
            return {
                "ok": True,
                "running": self._running,
                "connected": self._connected,
                "configured": settings.configured if settings else self._configured,
                "in_flight": self._in_flight,
                "last_error": self._last_error,
                "last_poll_at": self._last_poll_at,
                "last_success_at": self._last_success_at,
                "last_reason": self._last_reason,
                "poll_interval_seconds": settings.poll_interval_seconds if settings else DEFAULT_POLL_INTERVAL_SECONDS,
                "background_sync_enabled": settings.background_sync_enabled if settings else True,
                "startup_auto_connect": settings.startup_auto_connect if settings else True,
                "reconnect_enabled": settings.reconnect_enabled if settings else True,
                "last_result": dict(self._last_result),
            }

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            settings = self._load_settings(raise_errors=False)
            if not settings or not settings.configured or not settings.background_sync_enabled:
                self._stop_event.wait(DEFAULT_POLL_INTERVAL_SECONDS)
                continue
            try:
                self.poll(reason="background")
            except Exception:
                pass
            self._stop_event.wait(settings.poll_interval_seconds)

    def _ensure_thread(self) -> None:
        with self._state_lock:
            if self._thread and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._loop, name="spaila-mail-service", daemon=True)
            self._thread.start()

    def _load_settings(self, *, raise_errors: bool = True) -> MailSettings | None:
        try:
            return MailSettings.from_raw(self._settings_loader())
        except Exception as error:
            with self._state_lock:
                self._configured = False
                self._connected = False
                self._last_error = str(error) or "Email settings unavailable."
            if raise_errors:
                raise
            return None

    def _empty_result(self, *, error: str = "") -> Dict[str, object]:
        with self._state_lock:
            self._last_error = error
            self._connected = False
        return {"status": "ok", "saved": 0, "skipped": 0, "fetched": 0, "last_seen_uid": 0, "error": error}

    def _log(self, label: str, payload: dict) -> None:
        print(f"{label} " + json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


mail_service = MailService()
