from fastapi import APIRouter, Body, HTTPException
from .mail_service import mail_service
from .inbox_service import mark_source_deleted


router = APIRouter()


@router.post("/inbox/fetch")
def fetch_inbox_emails(payload: dict = Body(default={})):
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
    }


@router.get("/inbox/resync")
def resync_inbox_emails(limit: int = 100):
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
    return mail_service.start()


@router.post("/inbox/service/stop")
def stop_inbox_service():
    return mail_service.stop(reason="api_stop")


@router.post("/inbox/service/reconnect")
def reconnect_inbox_service():
    return mail_service.reconnect(reason="api_reconnect")


def _delete_inbox_email_by_id(email_id: str):
    email_id = str(email_id or "").strip()
    print(f"[TRASH_SERVER_DELETE] email_id={email_id}")
    try:
        mail_service.delete_email(email_id)
        mark_source_deleted(email_id, True)
        print(f"[TRASH_SERVER_SUCCESS] email_id={email_id}")
    except ValueError as error:
        mark_source_deleted(email_id, False)
        print(f"[TRASH_SERVER_FAIL] email_id={email_id} error={error}")
        raise HTTPException(status_code=400, detail=str(error)) from error
    except FileNotFoundError:
        mark_source_deleted(email_id, True)
        print(f"[TRASH_SERVER_SUCCESS] email_id={email_id} already_missing=true")
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as error:
        message = str(error) or "Could not delete inbox email."
        if "not found" in message.lower():
            mark_source_deleted(email_id, True)
            print(f"[TRASH_SERVER_SUCCESS] email_id={email_id} already_missing=true")
            return {"status": "ok"}
        mark_source_deleted(email_id, False)
        print(f"[TRASH_SERVER_FAIL] email_id={email_id} error={message}")
        raise HTTPException(status_code=500, detail=str(error) or "Could not delete inbox email.") from error

    return {"status": "ok", "source_deleted": True}


@router.delete("/inbox")
def delete_inbox(email_id: str):
    print(f"[TRASH_REQUEST] email_id={email_id}")
    try:
        return _delete_inbox_email_by_id(email_id)
    except FileNotFoundError:
        pass
    return {"status": "ok"}


@router.post("/inbox/delete")
def delete_inbox_email_legacy(payload: dict):
    email_id = str(payload.get("email_id") or payload.get("emailId") or "").strip()
    return _delete_inbox_email_by_id(email_id)
