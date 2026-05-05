from fastapi import APIRouter, Body, HTTPException
from .mail_service import mail_service
from .inbox_service import mark_source_deleted
from backend.api.routes.account import _require_feature


router = APIRouter()


@router.post("/inbox/fetch")
def fetch_inbox_emails(payload: dict = Body(default={})):
    _require_feature("inbox")
    payload = payload if isinstance(payload, dict) else {}
    force = bool(payload.get("force", False))
    print("[INBOX FETCH] called")
    print("[INBOX FETCH] force =", force)
    try:
        result = mail_service.poll(force=True, resync=force, reason="manual_fetch")
    except ValueError as error:
        print("[INBOX FETCH ERROR]", error)
        return {
            "status": "ok",
            "saved": 0,
            "skipped": 0,
            "fetched": 0,
            "last_seen_uid": 0,
            "error": str(error),
        }
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error) or "Could not fetch inbox emails.") from error

    return {
        "status": "ok",
        "saved": result.get("saved", 0),
        "skipped": result.get("skipped", 0),
        "fetched": result.get("fetched", 0),
        "last_seen_uid": result.get("last_seen_uid", 0),
        "source_deleted_missing": result.get("source_deleted_missing", 0),
        "source_deleted_changed": result.get("source_deleted_changed", 0),
    }


@router.get("/inbox/resync")
def resync_inbox_emails(limit: int = 100):
    _require_feature("inbox")
    try:
        result = mail_service.poll(
            force=True,
            resync=True,
            reason="manual_resync",
            limit=max(1, min(int(limit or 100), 100)),
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error) or "Could not resync inbox emails.") from error

    return {
        "saved": result["saved"],
        "skipped": result.get("skipped", 0),
        "fetched": result.get("fetched", 0),
    }

@router.get("/inbox/check")
def check_inbox_connection():
    return mail_service.status()


@router.get("/inbox/service/status")
def inbox_service_status():
    return mail_service.status()


@router.post("/inbox/service/start")
def start_inbox_service():
    _require_feature("inbox")
    return mail_service.start()


@router.post("/inbox/service/stop")
def stop_inbox_service():
    return mail_service.stop(reason="api_stop")


@router.post("/inbox/service/reconnect")
def reconnect_inbox_service():
    _require_feature("inbox")
    return mail_service.reconnect(reason="api_reconnect")


def _delete_inbox_email_by_id(email_id: str, *, mailbox: str | None = None):
    email_id = str(email_id or "").strip()
    mailbox = str(mailbox or "").strip()
    print(f"[PERMANENT_DELETE_PROVIDER] email_id={email_id} mailbox={mailbox or 'default'}")
    try:
        mail_service.delete_email(email_id, mailbox=mailbox or None)
        mark_source_deleted(email_id, True)
        print(f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} action=permanent_delete")
    except ValueError as error:
        mark_source_deleted(email_id, False)
        print(f"[TRASH_PROVIDER_FAIL] email_id={email_id} action=permanent_delete error={error}")
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError:
        mark_source_deleted(email_id, True)
        print(f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} action=permanent_delete already_missing=true")
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as error:
        message = str(error) or "Could not delete inbox email."
        if "not found" in message.lower():
            mark_source_deleted(email_id, True)
            print(f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} action=permanent_delete already_missing=true")
            return {"status": "ok"}
        mark_source_deleted(email_id, False)
        print(f"[TRASH_PROVIDER_FAIL] email_id={email_id} action=permanent_delete error={message}")
        raise HTTPException(status_code=500, detail=str(error) or "Could not delete inbox email.") from error

    return {"status": "ok", "source_deleted": True}


def _move_inbox_email_to_provider_trash(email_id: str):
    email_id = str(email_id or "").strip()
    print(f"[TRASH_PROVIDER_MOVE] email_id={email_id}")
    try:
        result = mail_service.move_email_to_trash(email_id)
        mark_source_deleted(email_id, True)
        print(f"[TRASH_PROVIDER_FOLDER] email_id={email_id} trash_mailbox={result.get('trash_mailbox') or ''}")
        print(
            f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} "
            f"method={result.get('method') or ''} trash_mailbox={result.get('trash_mailbox') or ''}"
        )
        return {
            "status": "ok",
            "source_deleted": True,
            "provider_trash_folder": result.get("trash_mailbox") or "",
            "provider_trash_method": result.get("method") or "",
        }
    except ValueError as error:
        mark_source_deleted(email_id, False)
        print(f"[TRASH_PROVIDER_FAIL] email_id={email_id} error={error}")
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError:
        mark_source_deleted(email_id, True)
        print(f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} already_missing=true")
        return {"status": "ok", "source_deleted": True, "provider_trash_folder": "", "provider_trash_method": "missing"}
    except HTTPException:
        raise
    except Exception as error:
        message = str(error) or "Could not move inbox email to Trash."
        if "not found" in message.lower():
            mark_source_deleted(email_id, True)
            print(f"[TRASH_PROVIDER_SUCCESS] email_id={email_id} already_missing=true")
            return {"status": "ok", "source_deleted": True, "provider_trash_folder": "", "provider_trash_method": "missing"}
        mark_source_deleted(email_id, False)
        print(f"[TRASH_PROVIDER_FAIL] email_id={email_id} error={message}")
        raise HTTPException(status_code=500, detail=message) from error


@router.delete("/inbox")
def delete_inbox(email_id: str, mailbox: str = ""):
    print(f"[TRASH_REQUEST] email_id={email_id}")
    try:
        return _delete_inbox_email_by_id(email_id, mailbox=mailbox)
    except FileNotFoundError:
        pass
    return {"status": "ok"}


@router.post("/inbox/trash")
def trash_inbox_email(payload: dict = Body(default={})):
    payload = payload if isinstance(payload, dict) else {}
    email_id = str(payload.get("email_id") or payload.get("emailId") or "").strip()
    print(f"[TRASH_REQUEST] email_id={email_id}")
    return _move_inbox_email_to_provider_trash(email_id)


@router.post("/inbox/delete")
def delete_inbox_email_legacy(payload: dict):
    email_id = str(payload.get("email_id") or payload.get("emailId") or "").strip()
    mailbox = str(payload.get("mailbox") or "").strip()
    return _delete_inbox_email_by_id(email_id, mailbox=mailbox)
