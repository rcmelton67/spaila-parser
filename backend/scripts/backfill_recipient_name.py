"""
One-time backfill: copy billing_name → recipient_name for orders where
recipient_name is empty but billing_name is set.

This recovers shipping/recipient names for orders that were stored before the
Etsy platform semantics correction.  It does NOT overwrite any existing
recipient_name values.

Run:
    py backend/scripts/backfill_recipient_name.py
    py backend/scripts/backfill_recipient_name.py --dry-run   (preview only)
"""

import argparse
import sqlite3
from pathlib import Path

_here = Path(__file__).resolve()
# Try project-root spaila.db first (dev), fall back to backend/spaila.db (server)
_root_db   = _here.parent.parent.parent / "spaila.db"   # repo-root
_server_db = _here.parent.parent / "spaila.db"           # backend/
DB_PATH = _root_db if _root_db.exists() else _server_db


def run(dry_run: bool = False) -> None:
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    cur = db.cursor()

    # Verify columns exist
    cur.execute("PRAGMA table_info(orders)")
    cols = {r["name"] for r in cur.fetchall()}
    missing = {"billing_name", "recipient_name"} - cols
    if missing:
        print(f"[ERROR] Missing columns in orders table: {missing}")
        print("Run the DB migration first (alembic upgrade head or equivalent).")
        db.close()
        return

    # Audit before
    cur.execute("SELECT COUNT(*) FROM orders")
    total = cur.fetchone()[0]

    cur.execute(
        "SELECT COUNT(*) FROM orders "
        "WHERE (billing_name IS NOT NULL AND billing_name != '') "
        "AND (recipient_name IS NULL OR recipient_name = '')"
    )
    needs_backfill = cur.fetchone()[0]

    cur.execute(
        "SELECT COUNT(*) FROM orders "
        "WHERE recipient_name IS NOT NULL AND recipient_name != ''"
    )
    already_has = cur.fetchone()[0]

    print(f"Total orders:                         {total}")
    print(f"Already have recipient_name:           {already_has}")
    print(f"Need backfill (billing_name → recip):  {needs_backfill}")

    if needs_backfill == 0:
        print("\nNothing to backfill. All orders already have recipient_name or no billing_name.")
        db.close()
        return

    if dry_run:
        # Show a sample of what would be changed
        cur.execute(
            "SELECT id, order_number, billing_name, platform FROM orders "
            "WHERE (billing_name IS NOT NULL AND billing_name != '') "
            "AND (recipient_name IS NULL OR recipient_name = '') "
            "LIMIT 20"
        )
        rows = cur.fetchall()
        print(f"\nDry-run preview — first {len(rows)} of {needs_backfill} orders:")
        for row in rows:
            print(f"  id={row['id']:>6}  order={str(row['order_number'] or ''):>12}  "
                  f"platform={str(row['platform'] or ''):>10}  "
                  f"billing_name → recipient_name = {row['billing_name']!r}")
        print("\n(No changes made — re-run without --dry-run to apply.)")
    else:
        cur.execute(
            "UPDATE orders "
            "SET recipient_name = billing_name "
            "WHERE (billing_name IS NOT NULL AND billing_name != '') "
            "AND (recipient_name IS NULL OR recipient_name = '')"
        )
        db.commit()
        print(f"\n[OK] Backfilled recipient_name for {cur.rowcount} orders.")

    db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill recipient_name from billing_name")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
