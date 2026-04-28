"""
backfill_manifests.py

One-time migration script: generates manifest.json for archived order folders
that were created before the manifest writer was added to the archive pipeline.

Skips folders that already have a manifest.json that matches the current schema
(schema_version == 1 AND has pet_name key).  Re-writes old manifests that are
missing the pet_name field so the search_blob is complete.

Fields written to manifest (strict contract — nothing else):
    schema_version, order_id, order_number,
    buyer_name, buyer_email, shipping_address, pet_name,
    folder_name, folder_path, archived_at, search_blob

Usage:
    py -3 backend/scripts/backfill_manifests.py
"""

import json
import re
from datetime import datetime
from pathlib import Path

ARCHIVE_ROOT = Path("C:/Spaila/archive")

# Schema is "current" when it has the pet_name key regardless of value.
CURRENT_SCHEMA_KEYS = {"pet_name"}


def build_search_blob(order_number, buyer_name, buyer_email, shipping_address, pet_name):
    return " ".join(
        str(v or "") for v in (order_number, buyer_name, buyer_email, shipping_address, pet_name)
    ).lower()


def _str(value):
    s = str(value or "").strip()
    return s or None


def extract_from_conversation(convo):
    """
    Pull core fields from the conversation root first, then fall back to
    best-effort message-body parsing for order_number and buyer_email.

    Returns (order_number, buyer_name, buyer_email, shipping_address, pet_name).
    Any value may be None.
    """
    order_number     = _str(convo.get("order_number"))
    buyer_name       = _str(convo.get("buyer_name"))
    buyer_email      = _str(convo.get("buyer_email"))
    shipping_address = _str(convo.get("shipping_address"))
    pet_name         = _str(convo.get("pet_name"))

    if order_number and buyer_email:
        return order_number, buyer_name, buyer_email, shipping_address, pet_name

    for msg in convo.get("messages", []):
        body = str(msg.get("body") or "").lower()

        if not order_number and "order" in body:
            m = re.search(r"\b\d{6,}\b", body)
            if m:
                order_number = m.group(0)

        if not buyer_email and "@" in body:
            m = re.search(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", body)
            if m:
                buyer_email = m.group(0)

        if order_number and buyer_email:
            break

    return order_number, buyer_name, buyer_email, shipping_address, pet_name


def needs_backfill(manifest_path: Path) -> bool:
    """Return True if the folder needs a (re-)write of manifest.json."""
    if not manifest_path.exists():
        return True
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return True
        # Re-write if any current-schema key is absent (upgrade old manifests).
        return not CURRENT_SCHEMA_KEYS.issubset(data.keys())
    except (OSError, json.JSONDecodeError):
        return True


def backfill():
    count = 0
    skipped = 0
    errors = 0

    for folder in ARCHIVE_ROOT.rglob("*"):
        if not folder.is_dir():
            continue

        manifest_path = folder / "manifest.json"
        convo_path    = folder / "conversation.json"

        if not needs_backfill(manifest_path):
            skipped += 1
            continue

        if not convo_path.exists():
            print(f"[SKIP] No conversation.json: {folder}")
            continue

        try:
            convo = json.loads(convo_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[ERROR] Reading conversation.json: {folder} → {exc}")
            errors += 1
            continue

        if not isinstance(convo, dict):
            print(f"[ERROR] conversation.json is not a dict: {folder}")
            errors += 1
            continue

        # Prefer existing manifest values where available (partial upgrade).
        existing = {}
        if manifest_path.exists():
            try:
                existing = json.loads(manifest_path.read_text(encoding="utf-8"))
                if not isinstance(existing, dict):
                    existing = {}
            except (OSError, json.JSONDecodeError):
                existing = {}

        (order_number, buyer_name, buyer_email,
         shipping_address, pet_name) = extract_from_conversation(convo)

        # Prefer already-correct values from an existing (partial) manifest.
        order_number     = _str(existing.get("order_number"))     or order_number
        buyer_name       = _str(existing.get("buyer_name"))       or buyer_name
        buyer_email      = _str(existing.get("buyer_email"))      or buyer_email
        shipping_address = _str(existing.get("shipping_address")) or shipping_address
        pet_name         = _str(existing.get("pet_name"))         or pet_name
        order_id         = _str(existing.get("order_id"))         or _str(convo.get("order_id"))
        archived_at      = (_str(existing.get("archived_at"))
                            or _str(convo.get("archived_at"))
                            or datetime.utcnow().isoformat())

        manifest = {
            "schema_version":  1,
            "order_id":        order_id,
            "order_number":    order_number,
            "buyer_name":      buyer_name,
            "buyer_email":     buyer_email,
            "shipping_address": shipping_address,
            "pet_name":        pet_name,
            "folder_name":     folder.name,
            "folder_path":     str(folder),
            "archived_at":     archived_at,
            "search_blob":     build_search_blob(
                order_number, buyer_name, buyer_email, shipping_address, pet_name
            ),
        }

        try:
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            action = "Upgraded" if existing else "Backfilled"
            print(f"[OK] {action}: {folder.name}")
            count += 1
        except Exception as exc:
            print(f"[ERROR] Writing manifest.json: {folder} → {exc}")
            errors += 1

    print(f"\nDone — written/upgraded: {count}  already current: {skipped}  errors: {errors}")


if __name__ == "__main__":
    backfill()
