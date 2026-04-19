"""TRUE FULL RESET of all learning and confidence state.

Hard-deletes every JSON store file then recreates it as {}.
Attempts SQLite table deletes if spaila.db exists.
Prints exact RESET_VERIFICATION counts after reset.
Exits with code 1 and an ERROR line if ANY count > 0.
"""
import json
import os
import sys
import sqlite3

ROOT = os.path.dirname(os.path.abspath(__file__))

# ── File paths ────────────────────────────────────────────────────────────────
LEARNING_STORE  = os.path.join(ROOT, "parser", "learning", "learning_store.json")
ANCHOR_STORE    = os.path.join(ROOT, "parser", "anchors",  "anchor_store.json")
REPLAY_STORE    = os.path.join(ROOT, "parser", "replay",   "replay_store.json")
# Must match CONFIDENCE_STORE_PATH in confidence_store.py (anchored to that file's dir)
CONFIDENCE_FILE = os.path.join(ROOT, "parser", "learning", "confidence_store.json")
DB_PATH         = os.path.join(ROOT, "spaila.db")

# SQLite learning tables (delete all rows; skip if table doesn't exist)
SQLITE_LEARNING_TABLES = [
    "learning_assignments",
    "learning_rejections",
    "learning_anchors",
    "learning_events",
    "replay_table",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _count_learning(path: str) -> tuple[int, int, int]:
    """Return (assignments, rejections, anchors) from a learning-style JSON store."""
    if not os.path.exists(path):
        return 0, 0, 0
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:
        return 0, 0, 0
    assignments = sum(1 for recs in data.values() for r in recs if r.get("type") == "assign")
    rejections  = sum(1 for recs in data.values() for r in recs if r.get("type") == "reject")
    anchors     = sum(len(recs) for recs in data.values())
    return assignments, rejections, anchors


def _count_flat(path: str) -> int:
    """Return count of top-level keys in a flat JSON dict (e.g. replay / confidence)."""
    if not os.path.exists(path):
        return 0
    try:
        return len(json.load(open(path, encoding="utf-8")))
    except Exception:
        return 0


def _hard_clear(path: str, label: str) -> None:
    """Delete the file (if it exists) then recreate it as {}."""
    if os.path.exists(path):
        os.remove(path)
        print(f"  DELETED  {label}")
    else:
        print(f"  MISSING  {label}  (no file to delete)")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({}, f, indent=2)
    print(f"  CREATED  {label}  -> {{}}")


def _clear_sqlite_tables() -> None:
    """DELETE all rows from learning tables in spaila.db if it exists."""
    if not os.path.exists(DB_PATH):
        print(f"  SKIP  spaila.db  (not found — no SQLite learning tables to clear)")
        return

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing = {row[0] for row in cur.fetchall()}

    for table in SQLITE_LEARNING_TABLES:
        if table not in existing:
            print(f"  SKIP  table:{table}  (does not exist)")
            continue
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        before = cur.fetchone()[0]
        cur.execute(f"DELETE FROM {table}")
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        after = cur.fetchone()[0]
        status = "OK" if after == 0 else "FAIL"
        print(f"  {status}   table:{table}  {before} → {after} rows")

    conn.commit()
    conn.close()


def _verify_counts() -> dict:
    """Read all stores and return exact post-reset counts."""
    a, rej, _ = _count_learning(LEARNING_STORE)
    anc_a, anc_rej, _ = _count_learning(ANCHOR_STORE)
    anchors = anc_a + anc_rej
    replay  = _count_flat(REPLAY_STORE)
    conf    = _count_flat(CONFIDENCE_FILE)
    return {
        "assignments": a,
        "rejections":  rej,
        "anchors":     anchors,
        "replay":      replay,
        "confidence_records": conf,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print("\n=== TRUE FULL LEARNING RESET ===\n")

    # ── PRE-RESET: show counts before deletion ────────────────────────────────
    pre_a, pre_rej, _ = _count_learning(LEARNING_STORE)
    pre_anc           = sum(_count_learning(ANCHOR_STORE)[:2])
    pre_replay        = _count_flat(REPLAY_STORE)
    pre_conf          = _count_flat(CONFIDENCE_FILE)
    print(
        "PRE-RESET STATE {\n"
        f"    assignments:        {pre_a},\n"
        f"    rejections:         {pre_rej},\n"
        f"    anchors:            {pre_anc},\n"
        f"    replay:             {pre_replay},\n"
        f"    confidence_records: {pre_conf}\n"
        "}\n"
    )

    # ── 1. Hard-clear JSON files ──────────────────────────────────────────────
    print("[1] Hard-clearing JSON learning stores ...")
    _hard_clear(LEARNING_STORE,  "parser/learning/learning_store.json")
    _hard_clear(ANCHOR_STORE,    "parser/anchors/anchor_store.json")
    _hard_clear(REPLAY_STORE,    "parser/replay/replay_store.json")
    _hard_clear(CONFIDENCE_FILE, "parser/learning/confidence_store.json")

    # ── 2. SQLite tables ──────────────────────────────────────────────────────
    print("\n[2] Clearing SQLite learning tables ...")
    _clear_sqlite_tables()

    # ── 3. Verify ─────────────────────────────────────────────────────────────
    print("\n[3] Verifying post-reset counts ...")
    counts = _verify_counts()

    print(
        "\nRESET_VERIFICATION {\n"
        f"    assignments:        {counts['assignments']},\n"
        f"    rejections:         {counts['rejections']},\n"
        f"    anchors:            {counts['anchors']},\n"
        f"    replay:             {counts['replay']},\n"
        f"    confidence_records: {counts['confidence_records']}\n"
        "}"
    )

    total = sum(counts.values())
    if total > 0:
        nonzero = [f"{k}={v}" for k, v in counts.items() if v > 0]
        print(
            f"\n[ERROR] RESET INCOMPLETE — {total} record(s) remain: {', '.join(nonzero)}",
            file=sys.stderr, flush=True,
        )
        sys.exit(1)

    print("\n[SUCCESS] All learning state is ZERO. Reset complete.\n")


if __name__ == "__main__":
    main()
