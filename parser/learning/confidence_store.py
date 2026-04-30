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
from typing import Dict, Set, Tuple

# Absolute path anchored to this file's location — never relative to CWD.
_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIDENCE_STORE_PATH = os.path.join(_HERE, "confidence_store.json")

CONFIDENCE_PROMOTION_THRESHOLD = 4

# ---------------------------------------------------------------------------
# Quarantine rules — signatures that MAY accumulate streaks for diagnostics
# but are BLOCKED from earning autopromote regardless of streak length.
#
# Rules are field-aware: an empty set blocks the signature for ALL fields;
# a non-empty set blocks only those listed fields (all others may promote).
# This prevents over-broad quarantine from stopping legitimate promotion of
# core fields like price.
# ---------------------------------------------------------------------------
_QUARANTINE_RULES: Dict[str, Set[str]] = {
    # Generic number-in-body — no semantic anchor, cannot reliably identify field
    "number_regex|none|body":     set(),
    "number_regex|none|order":    set(),
    "number_regex|none|header":   set(),
    "number_regex|none|shipping": set(),
    "number_regex|none|pricing":  set(),
    "number_regex|none|buyer":    set(),
    # price|pricing IS a valid signature for price but must never promote
    # non-price fields (e.g. a numeric price value mistaken for order_number).
    "number_regex|price|pricing": {"order_number", "quantity", "buyer_name",
                                   "buyer_email", "order_date", "ship_by",
                                   "shipping_address"},
    # Generic "from" body context for order_number
    "number_regex|from|body":     set(),
    # Shipping label context incorrectly captured as buyer_name
    "address_label_name|none|shipping": set(),
}


def _is_quarantined(extraction_signature: str, field: str = "") -> bool:
    """Return True when this signature is blocked from promotion for *field*.

    If *field* is omitted or the rule's blocked-fields set is empty, the
    signature is blocked for every field.
    """
    rule = _QUARANTINE_RULES.get(extraction_signature)
    if rule is None:
        return False
    # Empty set → blocked for all fields
    if not rule:
        return True
    # Non-empty set → blocked only for the listed fields
    return bool(field) and field in rule


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
    quarantined = _is_quarantined(extraction_signature, field)
    eligible = (streak >= CONFIDENCE_PROMOTION_THRESHOLD) and not quarantined
    promoted = eligible

    if quarantined:
        print(
            f"[CONF_STORE_QUARANTINE] sig={extraction_signature!r} field={field}"
            f" streak={streak} — blocked from autopromote (generic/invalid signature)",
            file=sys.stderr, flush=True,
        )

    print(
        f"CONF_PROMOTION_CHECK {{"
        f" field: {field},"
        f" streak: {streak},"
        f" eligible: {eligible},"
        f" quarantined: {quarantined},"
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
        sig = record.get("extraction_signature", "")
        if (
            record.get("streak_count", 0) >= CONFIDENCE_PROMOTION_THRESHOLD
            and not _is_quarantined(sig, field)
        ):
            promoted.add(field)
    return frozenset(promoted)


def get_promoted_signature_records(template_id: str, field: str, source: str = "") -> list[Dict]:
    """Return promoted confidence records for one field/template."""
    store = _load()
    promoted: list[Dict] = []
    prefix = f"{template_id}:{field}:"
    for key, record in store.items():
        if not key.startswith(prefix):
            continue
        if record.get("field") != field:
            continue
        if field == "quantity" and source and record.get("source", "") not in {"", source}:
            continue
        sig = record.get("extraction_signature", "")
        if record.get("streak_count", 0) < CONFIDENCE_PROMOTION_THRESHOLD:
            continue
        if _is_quarantined(sig, field):
            continue
        promoted.append({**record, "key": key})
    return promoted


def reset_field(template_id: str, field: str, source: str = "") -> int:
    """Remove confidence streaks for one field after an explicit user action."""
    store = _load()
    prefix = f"{template_id}:{field}:"
    removed = 0
    for key in list(store.keys()):
        if not key.startswith(prefix):
            continue
        record = store.get(key, {})
        if field == "quantity" and source and record.get("source", "") not in {"", source}:
            continue
        removed += 1
        del store[key]
    if removed:
        _save(store)
    print(
        f"[CONF_STORE_RESET_FIELD] template={template_id[:12]} field={field} removed={removed}",
        file=sys.stderr, flush=True,
    )
    return removed


def summarize_fields(fields: set[str]) -> Dict[str, Dict]:
    store = _load()
    summary = {
        field: {
            "entries": 0,
            "promoted": False,
            "max_streak": 0,
        }
        for field in fields
    }
    for record in store.values():
        field = record.get("field", "")
        if field not in summary:
            continue
        streak = int(record.get("streak_count", 0) or 0)
        summary[field]["entries"] += 1
        summary[field]["max_streak"] = max(summary[field]["max_streak"], streak)
        if streak >= CONFIDENCE_PROMOTION_THRESHOLD:
            summary[field]["promoted"] = True
    return summary


def reset_field_everywhere(field: str) -> int:
    """Remove confidence streaks for one field across all templates."""
    store = _load()
    removed = 0
    for key in list(store.keys()):
        if store.get(key, {}).get("field") != field:
            continue
        removed += 1
        del store[key]
    if removed:
        _save(store)
    return removed


def clear_all() -> int:
    """Wipe all confidence tracking records.  Returns count of records removed."""
    store = _load()
    count = len(store)
    _save({})
    return count
