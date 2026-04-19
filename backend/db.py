import sqlite3

DB_PATH = "spaila.db"


def get_conn():
    return sqlite3.connect(DB_PATH)


def _ensure_columns(cur, table: str, columns: list[tuple[str, str]]) -> None:
    """Add missing columns to an existing table (safe to call on every startup)."""
    cur.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cur.fetchall()}
    for col_name, col_def in columns:
        if col_name not in existing:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}")
            print(f"[DB] migrated: added {table}.{col_name}")


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_number TEXT,
        order_date TEXT,
        buyer_name TEXT,
        buyer_email TEXT,
        shipping_address TEXT,
        ship_by TEXT,
        status TEXT,
        created_at TEXT,
        order_folder_path TEXT,
        source_eml_path TEXT,
        eml_path TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        item_index INTEGER,
        quantity INTEGER,
        price TEXT,
        custom_1 TEXT,
        custom_2 TEXT,
        custom_3 TEXT,
        custom_4 TEXT,
        custom_5 TEXT,
        custom_6 TEXT
    )
    """)

    # Migrate existing databases that predate these columns
    _ensure_columns(cur, "orders", [
        ("order_folder_path", "TEXT"),
        ("source_eml_path",   "TEXT"),
        ("eml_path",          "TEXT"),
    ])

    conn.commit()
    conn.close()
