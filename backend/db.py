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
        eml_path TEXT,
        messages TEXT,
        is_gift INTEGER DEFAULT 0,
        gift_wrap INTEGER DEFAULT 0
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

    cur.execute("""
    CREATE TABLE IF NOT EXISTS inbox_events (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,   -- "new_order" | "order_update"
        order_id    TEXT,
        order_number TEXT,
        buyer_name  TEXT,
        preview     TEXT,
        timestamp   TEXT,
        unread      INTEGER DEFAULT 1,
        created_at  TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS archive_orders (
        archive_id TEXT PRIMARY KEY,
        original_order_id TEXT,
        order_number TEXT,
        buyer_name TEXT,
        buyer_email TEXT,
        shipping_address TEXT,
        pet_name TEXT,
        order_date TEXT,
        archived_at TEXT,
        archive_status TEXT DEFAULT 'archived',
        folder_name TEXT,
        folder_path TEXT,
        manifest_path TEXT,
        conversation_path TEXT,
        product_text TEXT,
        notes_text TEXT,
        conversation_text TEXT,
        search_blob TEXT,
        updated_at TEXT
    )
    """)
    cur.execute("""
    CREATE VIRTUAL TABLE IF NOT EXISTS archive_orders_fts USING fts5(
        archive_id UNINDEXED,
        order_number,
        buyer_name,
        buyer_email,
        shipping_address,
        pet_name,
        order_date,
        product_text,
        notes_text,
        conversation_text,
        search_blob
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS account_profiles (
        account_id TEXT PRIMARY KEY,
        shop_id TEXT,
        shop_name TEXT,
        owner_name TEXT,
        account_email TEXT,
        business_timezone TEXT,
        plan_code TEXT DEFAULT 'local',
        subscription_state TEXT DEFAULT 'local_only',
        auth_mode TEXT DEFAULT 'local_first',
        multi_shop_ready INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS account_users (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'owner',
        created_at TEXT,
        updated_at TEXT,
        last_login_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT,
        expires_at TEXT,
        revoked_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT,
        expires_at TEXT,
        used_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS billing_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        payload_json TEXT,
        received_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS trial_install_history (
        install_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        first_email TEXT,
        trial_started_at TEXT,
        trial_ends_at TEXT,
        created_at TEXT,
        updated_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS web_settings (
        account_id TEXT PRIMARY KEY,
        default_order_scope TEXT DEFAULT 'active',
        default_order_sort TEXT DEFAULT 'newest',
        order_density TEXT DEFAULT 'comfortable',
        show_attachment_previews INTEGER DEFAULT 1,
        archive_default_status TEXT DEFAULT 'archived',
        created_at TEXT,
        updated_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS business_assets (
        account_id TEXT NOT NULL,
        asset_key TEXT NOT NULL,
        name TEXT,
        mime_type TEXT,
        content_base64 TEXT,
        source_path TEXT,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (account_id, asset_key)
    )
    """)

    # Migrate existing databases that predate these columns
    _ensure_columns(cur, "orders", [
        ("order_folder_path", "TEXT"),
        ("source_eml_path",   "TEXT"),
        ("eml_path",          "TEXT"),
        ("source_original_path", "TEXT"),
        ("platform",          "TEXT"),   # "etsy" | "woo" | "shopify" | "unknown"
        ("messages",          "TEXT"),   # JSON conversation messages persisted per order
        ("is_gift",           "INTEGER DEFAULT 0"),
        ("gift_wrap",         "INTEGER DEFAULT 0"),
        ("shipping_name",     "TEXT"),
        ("phone_number",      "TEXT"),
        ("last_activity_at",  "TEXT"),
        ("updated_at",        "TEXT"),
        ("pet_name",          "TEXT"),   # primary personalisation field for archive/search
        # gift_message intentionally NOT here — it lives in items (per-item)
    ])
    _ensure_columns(cur, "items", [
        ("order_notes",       "TEXT"),
        ("gift_message",      "TEXT"),   # per-item, not order-level
        ("item_status",       "TEXT"),   # per-item active/completed — independent of order.status
    ])
    _ensure_columns(cur, "archive_orders", [
        ("original_order_id", "TEXT"),
        ("order_number", "TEXT"),
        ("buyer_name", "TEXT"),
        ("buyer_email", "TEXT"),
        ("shipping_address", "TEXT"),
        ("pet_name", "TEXT"),
        ("order_date", "TEXT"),
        ("archived_at", "TEXT"),
        ("archive_status", "TEXT DEFAULT 'archived'"),
        ("folder_name", "TEXT"),
        ("folder_path", "TEXT"),
        ("manifest_path", "TEXT"),
        ("conversation_path", "TEXT"),
        ("product_text", "TEXT"),
        ("notes_text", "TEXT"),
        ("conversation_text", "TEXT"),
        ("search_blob", "TEXT"),
        ("updated_at", "TEXT"),
    ])
    _ensure_columns(cur, "account_profiles", [
        ("shop_id", "TEXT"),
        ("shop_name", "TEXT"),
        ("owner_name", "TEXT"),
        ("account_email", "TEXT"),
        ("business_timezone", "TEXT"),
        ("shop_logo_path", "TEXT"),
        ("plan_code", "TEXT DEFAULT 'local'"),
        ("subscription_state", "TEXT DEFAULT 'local_only'"),
        ("auth_mode", "TEXT DEFAULT 'local_first'"),
        ("multi_shop_ready", "INTEGER DEFAULT 0"),
        ("trial_started_at", "TEXT"),
        ("trial_ends_at", "TEXT"),
        ("trial_device_id", "TEXT"),
        ("trial_claimed_at", "TEXT"),
        ("entitlement_last_verified_at", "TEXT"),
        ("entitlement_last_server_time", "TEXT"),
        ("clock_tamper_detected", "INTEGER DEFAULT 0"),
        ("stripe_customer_id", "TEXT"),
        ("stripe_subscription_id", "TEXT"),
        ("subscription_status", "TEXT"),
        ("subscription_current_period_end", "TEXT"),
        ("subscription_cancel_at_period_end", "INTEGER DEFAULT 0"),
        ("billing_status", "TEXT DEFAULT 'not_configured'"),
        ("last_payment_status", "TEXT"),
        ("canceled_at", "TEXT"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
    ])
    _ensure_columns(cur, "account_users", [
        ("account_id", "TEXT"),
        ("email", "TEXT"),
        ("name", "TEXT"),
        ("password_hash", "TEXT"),
        ("role", "TEXT DEFAULT 'owner'"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
        ("last_login_at", "TEXT"),
    ])
    _ensure_columns(cur, "auth_sessions", [
        ("user_id", "TEXT"),
        ("account_id", "TEXT"),
        ("created_at", "TEXT"),
        ("expires_at", "TEXT"),
        ("revoked_at", "TEXT"),
    ])
    _ensure_columns(cur, "password_reset_tokens", [
        ("user_id", "TEXT"),
        ("account_id", "TEXT"),
        ("created_at", "TEXT"),
        ("expires_at", "TEXT"),
        ("used_at", "TEXT"),
    ])
    _ensure_columns(cur, "billing_events", [
        ("event_type", "TEXT"),
        ("stripe_customer_id", "TEXT"),
        ("stripe_subscription_id", "TEXT"),
        ("payload_json", "TEXT"),
        ("received_at", "TEXT"),
    ])
    _ensure_columns(cur, "trial_install_history", [
        ("account_id", "TEXT"),
        ("first_email", "TEXT"),
        ("trial_started_at", "TEXT"),
        ("trial_ends_at", "TEXT"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
    ])
    _ensure_columns(cur, "web_settings", [
        ("default_order_scope", "TEXT DEFAULT 'active'"),
        ("default_order_sort", "TEXT DEFAULT 'newest'"),
        ("order_density", "TEXT DEFAULT 'comfortable'"),
        ("show_completed_tab", "INTEGER DEFAULT 1"),
        ("show_inventory_tab", "INTEGER DEFAULT 0"),
        ("show_thank_you_shortcut", "INTEGER DEFAULT 1"),
        ("show_attachment_previews", "INTEGER DEFAULT 1"),
        ("archive_default_status", "TEXT DEFAULT 'archived'"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
    ])
    _ensure_columns(cur, "business_assets", [
        ("account_id", "TEXT"),
        ("asset_key", "TEXT"),
        ("name", "TEXT"),
        ("mime_type", "TEXT"),
        ("content_base64", "TEXT"),
        ("source_path", "TEXT"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
    ])

    cur.execute("CREATE INDEX IF NOT EXISTS idx_archive_orders_order_number ON archive_orders(order_number)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_archive_orders_buyer_email ON archive_orders(buyer_email)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_archive_orders_archived_at ON archive_orders(archived_at)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_archive_orders_status ON archive_orders(archive_status)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_archive_orders_folder_path ON archive_orders(folder_path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_account_users_account_id ON account_users(account_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_account_id ON auth_sessions(account_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trial_install_history_account_id ON trial_install_history(account_id)")

    cur.execute(
        "UPDATE orders SET last_activity_at = created_at "
        "WHERE last_activity_at IS NULL OR TRIM(last_activity_at) = ''"
    )
    cur.execute(
        "UPDATE orders SET updated_at = created_at "
        "WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
    )

    # ── Path casing normalisation ─────────────────────────────────────────────
    # Ensure all stored paths use Title-Case month names (April not april) and
    # capital Inbox (not inbox).  Safe to run on every startup — SQLite's
    # replace() is a no-op when the substring is not present.
    _MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    path_cols = [
        ("orders",         "order_folder_path"),
        ("orders",         "source_eml_path"),
        ("orders",         "eml_path"),
        ("orders",         "source_original_path"),
        ("archive_orders", "folder_path"),
        ("archive_orders", "manifest_path"),
        ("archive_orders", "conversation_path"),
    ]
    for table, col in path_cols:
        # Fix month casing (both / and \ separators)
        for month in _MONTH_NAMES:
            for old_frag, new_frag in (
                (f"/{month.lower()}/",         f"/{month}/"),
                ("\\" + month.lower() + "\\",  "\\" + month + "\\"),
            ):
                try:
                    cur.execute(
                        f"UPDATE {table} SET {col} = replace({col}, ?, ?) "  # noqa: S608
                        f"WHERE {col} LIKE ?",
                        (old_frag, new_frag, f"%{old_frag}%"),
                    )
                except Exception:
                    pass
        # Fix inbox casing: /inbox/ or \inbox\ → /Inbox/ or \Inbox\
        for old_frag, new_frag in (
            ("/inbox/",    "/Inbox/"),
            ("\\inbox\\",  "\\Inbox\\"),
        ):
            try:
                cur.execute(
                    f"UPDATE {table} SET {col} = replace({col}, ?, ?) "  # noqa: S608
                    f"WHERE {col} LIKE ?",
                    (old_frag, new_frag, f"%{old_frag}%"),
                )
            except Exception:
                pass

    # Also fix the messages JSON column for inline attachment paths
    import json as _json
    try:
        cur.execute("SELECT id, messages FROM orders WHERE messages IS NOT NULL AND messages != ''")
        rows = cur.fetchall()
        for row_id, messages_json in rows:
            try:
                msgs = _json.loads(messages_json)
                if not isinstance(msgs, list):
                    continue
                changed = False
                for msg in msgs:
                    if not isinstance(msg, dict):
                        continue
                    for field in ("original_path", "path", "thumbnail_path"):
                        val = msg.get(field)
                        if not val:
                            continue
                        new_val = val
                        for month in _MONTH_NAMES:
                            new_val = new_val.replace(f"/{month.lower()}/", f"/{month}/")
                            new_val = new_val.replace("\\" + month.lower() + "\\", "\\" + month + "\\")
                        new_val = new_val.replace("/inbox/", "/Inbox/")
                        new_val = new_val.replace("\\inbox\\", "\\Inbox\\")
                        if new_val != val:
                            msg[field] = new_val
                            changed = True
                    for att in msg.get("attachments", []):
                        if not isinstance(att, dict):
                            continue
                        for field in ("original_path", "path", "thumbnail_path"):
                            val = att.get(field)
                            if not val:
                                continue
                            new_val = val
                            for month in _MONTH_NAMES:
                                new_val = new_val.replace(f"/{month.lower()}/", f"/{month}/")
                                new_val = new_val.replace("\\" + month.lower() + "\\", "\\" + month + "\\")
                            new_val = new_val.replace("/inbox/", "/Inbox/")
                            new_val = new_val.replace("\\inbox\\", "\\Inbox\\")
                            if new_val != val:
                                att[field] = new_val
                                changed = True
                if changed:
                    cur.execute(
                        "UPDATE orders SET messages = ? WHERE id = ?",
                        (_json.dumps(msgs, ensure_ascii=False), row_id),
                    )
            except Exception:
                pass
    except Exception:
        pass

    conn.commit()
    conn.close()
