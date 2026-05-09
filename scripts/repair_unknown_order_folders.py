from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from workspace_paths import get_workspace_dirs


EN_DASH = "\u2013"
UNKNOWN_FOLDER_RE = re.compile(rf"^Unknown\s+(?:{EN_DASH}|-)\s+(.+)$")
ORDER_FOLDER_NAME_KEYS = (
    "recipient_name",
    "shipping_name",
    "billing_name",
    "buyer_name",
    "billing_email",
    "buyer_email",
    "email",
)


@dataclass(frozen=True)
class OrderRecord:
    order_id: str | None
    order_number: str
    order_folder_path: str | None
    values: dict[str, str | None]


@dataclass(frozen=True)
class RepairCandidate:
    source: Path
    target: Path
    order: OrderRecord
    old_order_folder_path: str | None


def _sanitize_for_fs(text: str) -> str:
    text = str(text).strip()
    text = re.sub(r'[<>:"/\\|?*]', "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _normalize_order_number(value: object) -> str:
    return str(value or "").replace("#", "").strip()


def _first_nonempty(values: dict[str, str | None], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = values.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _format_folder_name(display_name: str | None, order_number: str) -> str:
    oid = _sanitize_for_fs(order_number) or "unknown"
    if not display_name:
        return f"Unknown {EN_DASH} {oid}"

    name = _sanitize_for_fs(display_name)
    lower = name.lower()
    if any(part in lower for part in ("family", "llc", "inc", "corp", "company")):
        return f"{name} {EN_DASH} {oid}"

    parts = name.split()
    if len(parts) < 2:
        return f"{name} {EN_DASH} {oid}"

    first = parts[0]
    last = parts[-1]
    middle = " ".join(parts[1:-1])
    formatted = f"{last}, {first} {middle}".strip() if middle else f"{last}, {first}"
    return f"{formatted} {EN_DASH} {oid}"


def _extract_unknown_order_number(folder: Path) -> str | None:
    match = UNKNOWN_FOLDER_RE.match(folder.name)
    if not match:
        return None
    return _normalize_order_number(match.group(1))


def _iter_unknown_order_folders(orders_root: Path) -> Iterable[Path]:
    if not orders_root.exists():
        return
    for folder in orders_root.rglob("*"):
        if folder.is_dir() and _extract_unknown_order_number(folder):
            yield folder


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row[1]) for row in rows}


def _load_orders(db_path: Path) -> tuple[dict[str, OrderRecord], dict[str, list[OrderRecord]]]:
    if not db_path.exists():
        raise FileNotFoundError(f"DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        columns = _table_columns(conn, "orders")
        if not columns:
            raise RuntimeError("orders table not found or has no columns")

        select_columns = [col for col in ("id", "order_number", "order_folder_path", "status") if col in columns]
        select_columns += [col for col in ORDER_FOLDER_NAME_KEYS if col in columns and col not in select_columns]
        if "order_number" not in select_columns:
            raise RuntimeError("orders.order_number column is required")

        query = f"SELECT {', '.join(select_columns)} FROM orders"
        if "status" in columns:
            query += " WHERE status IS NULL OR status NOT IN ('deleted')"

        by_number: dict[str, list[OrderRecord]] = {}
        for row in conn.execute(query):
            order_number = _normalize_order_number(row["order_number"])
            if not order_number:
                continue
            values = {
                key: row[key]
                for key in ORDER_FOLDER_NAME_KEYS
                if key in row.keys()
            }
            record = OrderRecord(
                order_id=row["id"] if "id" in row.keys() else None,
                order_number=order_number,
                order_folder_path=row["order_folder_path"] if "order_folder_path" in row.keys() else None,
                values=values,
            )
            by_number.setdefault(order_number, []).append(record)

        unique = {number: rows[0] for number, rows in by_number.items() if len(rows) == 1}
        duplicates = {number: rows for number, rows in by_number.items() if len(rows) > 1}
        return unique, duplicates
    finally:
        conn.close()


def _build_candidates(
    orders_root: Path,
    orders_by_number: dict[str, OrderRecord],
    duplicate_orders: dict[str, list[OrderRecord]],
) -> tuple[list[RepairCandidate], list[str]]:
    candidates: list[RepairCandidate] = []
    skipped: list[str] = []

    for folder in _iter_unknown_order_folders(orders_root):
        order_number = _extract_unknown_order_number(folder)
        if not order_number:
            continue
        print(f"[FOUND] {folder}")

        if order_number in duplicate_orders:
            skipped.append(f"[SKIP] duplicate active DB orders for order_number {order_number}: {folder}")
            continue

        order = orders_by_number.get(order_number)
        if not order:
            skipped.append(f"[SKIP] no active DB order for {folder}")
            continue

        display_name = _first_nonempty(order.values, ORDER_FOLDER_NAME_KEYS)
        if not display_name:
            skipped.append(f"[SKIP] no usable name/email for order {order_number}: {folder}")
            continue

        target = folder.with_name(_format_folder_name(display_name, order_number))
        print(f"[MATCH] order_number={order_number} display_name={display_name!r} target={target}")
        if target == folder:
            skipped.append(f"[SKIP] already canonical for order {order_number}: {folder}")
            continue
        if target.exists():
            skipped.append(f"[SKIP] target already exists for order {order_number}: {target}")
            continue

        candidates.append(
            RepairCandidate(
                source=folder,
                target=target,
                order=order,
                old_order_folder_path=order.order_folder_path,
            )
        )

    return candidates, skipped


def _same_path(left: str | None, right: Path) -> bool:
    if not left:
        return False
    return Path(left).expanduser().resolve() == right.expanduser().resolve()


def _retarget_path(value: str | None, old_root: Path, new_root: Path) -> str | None:
    if value is None or not str(value).strip():
        return value

    current = Path(str(value)).expanduser().resolve()
    old_resolved = old_root.expanduser().resolve()
    new_resolved = new_root.expanduser().resolve()
    if current == old_resolved:
        return str(new_resolved)
    try:
        relative = current.relative_to(old_resolved)
    except ValueError:
        return value
    return str(new_resolved / relative)


def _update_order_paths(db_path: Path, candidate: RepairCandidate) -> None:
    if not candidate.order.order_id:
        return
    if candidate.old_order_folder_path and not _same_path(candidate.old_order_folder_path, candidate.source):
        print(
            "[SKIP] DB update for "
            f"{candidate.order.order_number}: order_folder_path points elsewhere: {candidate.old_order_folder_path}"
        )
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        columns = _table_columns(conn, "orders")
        if "id" not in columns:
            return

        path_columns = [
            col
            for col in ("order_folder_path", "eml_path", "source_eml_path", "source_original_path")
            if col in columns
        ]
        if not path_columns:
            return

        row = conn.execute(
            f"SELECT {', '.join(path_columns)} FROM orders WHERE id = ?",
            (candidate.order.order_id,),
        ).fetchone()
        if not row:
            return

        updates: dict[str, str | None] = {}
        for column in path_columns:
            next_value = _retarget_path(row[column], candidate.source, candidate.target)
            if next_value != row[column]:
                updates[column] = next_value

        if not updates:
            return

        assignments = ", ".join(f"{column} = ?" for column in updates)
        conn.execute(
            f"UPDATE orders SET {assignments} WHERE id = ?",
            (*updates.values(), candidate.order.order_id),
        )
        conn.commit()
        print(
            "[DB UPDATE] "
            f"order_number={candidate.order.order_number} columns={', '.join(updates.keys())}"
        )
    finally:
        conn.close()


def repair_unknown_order_folders(db_path: Path, orders_root: Path, apply: bool) -> int:
    orders_by_number, duplicate_orders = _load_orders(db_path)
    candidates, skipped = _build_candidates(orders_root, orders_by_number, duplicate_orders)

    print(f"Orders root: {orders_root}")
    print(f"Database: {db_path}")
    print(f"Mode: {'APPLY' if apply else 'DRY RUN'}")
    print(f"Repairable folders: {len(candidates)}")
    print(f"Skipped folders/orders: {len(skipped)}")

    for candidate in candidates:
        print(f"[RENAME] {'APPLY' if apply else 'DRY RUN'} {candidate.source} -> {candidate.target}")

    for message in skipped:
        print(message)

    if not apply:
        return 0

    failures = 0
    for candidate in candidates:
        try:
            candidate.source.rename(candidate.target)
            print(f"[RENAME] DONE {candidate.source} -> {candidate.target}")
            _update_order_paths(db_path, candidate)
        except OSError as error:
            failures += 1
            print(f"[ERROR] failed to rename {candidate.source}: {error}", file=sys.stderr)

    return 1 if failures else 0


def main() -> int:
    default_dirs = get_workspace_dirs()
    default_db = Path.cwd() / "spaila.db"
    if not default_db.exists():
        default_db = ROOT / "spaila.db"
    parser = argparse.ArgumentParser(
        description="Repair order folders named 'Unknown \\u2013 <order_number>' using canonical order name fields."
    )
    parser.add_argument("--db", type=Path, default=default_db, help="Path to Spaila SQLite database.")
    parser.add_argument("--orders-root", type=Path, default=default_dirs["Orders"], help="Path to Orders workspace.")
    parser.add_argument("--apply", action="store_true", help="Actually rename folders. Default is dry-run only.")
    args = parser.parse_args()

    return repair_unknown_order_folders(
        db_path=args.db.expanduser().resolve(),
        orders_root=args.orders_root.expanduser().resolve(),
        apply=args.apply,
    )


if __name__ == "__main__":
    raise SystemExit(main())
