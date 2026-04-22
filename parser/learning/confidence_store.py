"""Confidence-based promotion tracker.

Tracks how many consecutive parses a field has returned the same value via
the same extraction method.  Once the streak reaches the threshold the
field is eligible for dynamic promotion from 'suggested' → 'assigned'
within that parse only — nothing is written to the learning store.
"""
import json
import os
import sys
import tempfile
import time
from typing import Dict, Tuple

# Absolute path anchored to this file's location — never relative to CWD.
_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIDENCE_STORE_PATH = os.path.join(_HERE, "confidence_store.json")

CONFIDENCE_PROMOTION_THRESHOLD = 4


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def _load() -> Dict:
    if not os.path.exists(CONFIDENCE_STORE_PATH):
        print(
            f"[CONF_STORE_LOAD] entries=0 path={CONFIDENCE_STORE_PATH} (file not found)",
            file=sys.stderr, flush=True,
        )
        return {}
    try:
        with open(CONFIDENCE_STORE_PATH, "r", encoding="utf-8") as f:
            store = json.load(f)
        print(
            f"[CONF_STORE_LOAD] entries={len(store)} path={CONFIDENCE_STORE_PATH}",
            file=sys.stderr, flush=True,
        )
        return store
    except (json.JSONDecodeError, OSError) as exc:
        print(
            f"[CONF_STORE_LOAD] ERROR reading store: {exc} path={CONFIDENCE_STORE_PATH}",
            file=sys.stderr, flush=True,
        )
        return {}


def _save(store: Dict) -> None:
    os.makedirs(os.path.dirname(CONFIDENCE_STORE_PATH), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix="confidence_store.",
        suffix=".tmp",
        dir=os.path.dirname(CONFIDENCE_STORE_PATH),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # Retry os.replace — Windows can hold a brief file lock between rapid
        # writes, causing PermissionError (WinError 5) on the atomic rename.
        for attempt in range(5):
            try:
                os.replace(tmp_path, CONFIDENCE_STORE_PATH)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05)  # 50 ms — enough for Windows to release the lock
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    print(
        f"[CONF_STORE_SAVE] entries={len(store)} path={CONFIDENCE_STORE_PATH}",
        file=sys.stderr, flush=True,
    )


# ---------------------------------------------------------------------------
# Core update
# ---------------------------------------------------------------------------

def update_streak(
    template_id: str,
    field: str,
    extraction_signature: str,
    value: str,
    source: str = "",
) -> Tuple[int, bool]:
    """Increment or reset the streak for (template_id, field, signature).

    Only called during a genuine import/parse, never during save_assignment or
    save_rejection flows (those pass update_confidence=False to parse_eml).

    Returns (streak_count, promoted) where promoted is True when
    streak_count >= CONFIDENCE_PROMOTION_THRESHOLD (4).
    """
    store = _load()
    legacy_key = f"{template_id}:{field}:{extraction_signature}"
    key = legacy_key
    if field == "quantity" and source:
        key = f"{template_id}:{field}:{extraction_signature}:{source}"

    record = store.get(key)
    if record is None and key != legacy_key:
        record = store.pop(legacy_key, None)

    record = record or {
        "field": field,
        "template_id": template_id,
        "extraction_signature": extraction_signature,
        "source": source if field == "quantity" else "",
        "last_value": None,
        "streak_count": 0,
    }

    record["streak_count"] = record.get("streak_count", 0) + 1
    record["last_value"] = value
    if field == "quantity":
        record["source"] = source

    store[key] = record
    _save(store)

    streak = record["streak_count"]
    eligible = (streak >= CONFIDENCE_PROMOTION_THRESHOLD)
    promoted  = eligible

    print(
        f"CONF_PROMOTION_CHECK {{"
        f" field: {field},"
        f" streak: {streak},"
        f" eligible: {eligible},"
        f" promoted: {promoted} }}",
        file=sys.stderr, flush=True,
    )

    return streak, promoted


def get_currently_promoted_fields(template_id: str, source_scopes: Dict[str, str] | None = None) -> frozenset:
    """Read-only scan: return fields that already have streak >= threshold.

    Does NOT mutate any streak counter — safe to call during interaction
    reparsing (update_confidence=False) so that confidence-promoted decisions
    survive accept/reject cycles without double-counting parses.
    """
    store = _load()
    promoted: set = set()
    prefix = f"{template_id}:"
    for key, record in store.items():
        if not key.startswith(prefix):
            continue
        field = record.get("field", "")
        if not field:
            continue
        if field == "quantity":
            expected_source = (source_scopes or {}).get("quantity", "")
            if expected_source and record.get("source", "") not in {"", expected_source}:
                continue
        if record.get("streak_count", 0) >= CONFIDENCE_PROMOTION_THRESHOLD:
            promoted.add(field)
    return frozenset(promoted)


def clear_all() -> int:
    """Wipe all confidence tracking records.  Returns count of records removed."""
    store = _load()
    count = len(store)
    _save({})
    return count
