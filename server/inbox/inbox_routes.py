from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from workspace_paths import get_workspace_root

from .inbox_service import fetch_and_store_emails


router = APIRouter()


def _load_email_settings() -> dict:
    settings_path = Path(get_workspace_root()) / "email_settings.json"
    if not settings_path.is_file():
        raise ValueError("Email settings have not been saved yet.")
    try:
        return json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise ValueError(f"Could not read email settings: {error}") from error


@router.post("/inbox/fetch")
def fetch_inbox_emails():
    try:
        settings = _load_email_settings()
        result = fetch_and_store_emails(
            host=settings.get("imapHost") or settings.get("imap_host"),
            username=settings.get("imapUsername") or settings.get("imap_user"),
            password=settings.get("imapPassword") or settings.get("imap_pass"),
            mailbox="INBOX",
            limit=settings.get("imapFetchLimit") or settings.get("imap_fetch_limit") or 20,
            port=settings.get("imapPort") or settings.get("imap_port") or 993,
            use_ssl=bool(settings.get("imapUseSsl", settings.get("imap_ssl", True))),
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error) or "Could not fetch inbox emails.") from error

    return {"saved": result["saved"]}
