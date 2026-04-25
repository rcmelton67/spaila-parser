from __future__ import annotations

import os
import re
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
from workspace_paths import ensure_workspace_layout

processed_files = set()
processing_files = set()
pending_files = set()
# normpath(filepath) -> time.time() when file was queued for matching
pending_since = {}
# filepath (normpath) -> last logged bool for [MATCH RESULT] (log only on change or first seen)
last_match_state = {}

# .eml paths present in inbox before watcher starts; not queued until a new drop (on_created).
initial_inbox_files: set[str] = set()

_WORKSPACE_DIRS = ensure_workspace_layout(print)
BASE_PATH = _WORKSPACE_DIRS["root"]
INBOX_PATH_STR = str(_WORKSPACE_DIRS["Inbox"])
ORDERS_PATH_STR = str(_WORKSPACE_DIRS["Orders"])
DUPLICATES_PATH_STR = str(_WORKSPACE_DIRS["Duplicates"])
ARCHIVE_PATH_STR = str(_WORKSPACE_DIRS["Archive"])
BACKUP_PATH_STR = str(_WORKSPACE_DIRS["Backup"])

ORDERS_API_URL = "http://localhost:8055/orders"


def init_folders():
    """Create canonical workspace folders under the shared Spaila root."""
    global INBOX_PATH_STR, ORDERS_PATH_STR, DUPLICATES_PATH_STR, ARCHIVE_PATH_STR, BACKUP_PATH_STR

    dirs = ensure_workspace_layout(print)
    INBOX_PATH_STR = str(dirs["Inbox"])
    ORDERS_PATH_STR = str(dirs["Orders"])
    DUPLICATES_PATH_STR = str(dirs["Duplicates"])
    ARCHIVE_PATH_STR = str(dirs["Archive"])
    BACKUP_PATH_STR = str(dirs["Backup"])

    print(f"[INIT] Base path: {dirs['root']}")
    print(f"[INIT] Inbox: {INBOX_PATH_STR}")
    print(f"[INIT] Orders: {ORDERS_PATH_STR}")
    print(f"[INIT] Duplicates: {DUPLICATES_PATH_STR}")


def ensure_folder(path):
    if not path:
        return

    try:
        if not os.path.exists(path):
            os.makedirs(path, exist_ok=True)
            print(f"[CREATED] {path}")
        else:
            print(f"[EXISTS] {path}")
    except Exception:
        pass


def extract_order_number_from_filename(filename):
    # Matches: Order #4020727216
    match = re.search(r"Order\s*#(\d+)", filename)
    if match:
        return match.group(1)
    return None


def extract_order_number_from_eml(file_path):
    try:
        from email import policy
        from email.parser import BytesParser

        with open(file_path, "rb") as f:
            msg = BytesParser(policy=policy.default).parse(f)

        body = ""
        subject = str(msg.get("subject") or "")
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body += part.get_content()
        else:
            body = msg.get_content()

        patterns = [
            r"order\s*(?:number|#)\s*[:#]?\s*(\d+)",
            r"your\s*order\s*number\s*is\s*[:\n\s]*([0-9]+)",
            r"order\s*[:#]?\s*(\d{6,})",
            r"\b(\d{8,})\b",  # fallback: long number
        ]
        for text in (subject, body):
            for pattern in patterns:
                match = re.search(pattern, text, re.IGNORECASE)
                if match:
                    return match.group(1)
    except Exception as e:
        print(f"[ERROR] parse eml {file_path}: {e}")

    return None


def _normalize_order_number(val):
    """Normalize for comparison; strip # and whitespace. Falsy input -> None (no match)."""
    if not val:
        return None
    return str(val).replace("#", "").strip() or None


def _sanitize_for_fs(text: str) -> str:
    """Same rules as server order folder names: safe Windows path segment."""
    text = str(text).strip()
    text = re.sub(r'[<>:\"/\\|?*]', "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def format_customer_name(name, order_number) -> str:
    """Last, First [Middle] – order_number. Skips reversal for company names."""
    oid = _sanitize_for_fs(str(order_number or "")) or "unknown"

    if not name:
        return f"Unknown – {oid}"

    name = _sanitize_for_fs(name.strip())
    lower = name.lower()

    # Don't reverse company / family names
    if any(x in lower for x in ["family", "llc", "inc", "corp", "company"]):
        return f"{name} – {oid}"

    parts = name.split()

    if len(parts) < 2:
        return f"{name} – {oid}"

    first = parts[0]
    last = parts[-1]
    middle = " ".join(parts[1:-1])

    formatted = f"{last}, {first} {middle}".strip() if middle else f"{last}, {first}"

    return f"{formatted} – {oid}"


def create_order_folder(row):
    """
    Build YYYY / month / '{customer} - {order_number}' under base orders path and mkdir.
    Uses order_date from row when present; otherwise today.
    """
    if not isinstance(row, dict):
        return None

    inner = row.get("order")
    order = inner if isinstance(inner, dict) else row
    if not isinstance(order, dict):
        order = row

    name = (
        order.get("buyer_name")
        or order.get("name")
        or row.get("buyer_name")
        or row.get("name")
        or "Unknown"
    )
    order_number = _order_number_from_dict(row)
    if not order_number:
        v = order.get("order_number")
        if v is not None and str(v).strip():
            order_number = str(v).strip()

    if not order_number:
        print("[FOLDER] Cannot create folder: missing order_number")
        return None

    folder_name = format_customer_name(name, order_number)

    od = order.get("order_date") or row.get("order_date")
    dt = None
    if od:
        try:
            s = str(od).strip()
            if len(s) >= 10 and s[4] == "-" and s[7] == "-":
                dt = datetime.fromisoformat(s[:10])
        except (TypeError, ValueError):
            pass
    if dt is None:
        dt = datetime.now()

    year = dt.strftime("%Y")
    month = dt.strftime("%B").lower()

    base = _base_orders_folder_from_settings()
    path = os.path.normpath(os.path.join(base, year, month, folder_name))

    try:
        os.makedirs(path, exist_ok=True)
    except OSError as e:
        print(f"[FOLDER] mkdir failed: {e}")
        return None

    return path


def _source_eml_path_from_dict(row) -> str | None:
    """Absolute path to the on-disk import file to move (staged .eml, inbox, future .txt, etc.)."""
    if not isinstance(row, dict):
        return None
    for key in ("source_eml_path", "source_import_path"):
        v = row.get(key)
        if v is not None and str(v).strip():
            return str(v).strip()
    inner = row.get("order")
    if inner and isinstance(inner, dict):
        for key in ("source_eml_path", "source_import_path"):
            v = inner.get(key)
            if v is not None and str(v).strip():
                return str(v).strip()
    return None


def _source_original_path_from_dict(row) -> str | None:
    """Path to remove after staged import succeeds (e.g. temp staging file)."""
    if not isinstance(row, dict):
        return None
    v = row.get("source_original_path")
    if v is not None and str(v).strip():
        return str(v).strip()
    inner = row.get("order")
    if inner and isinstance(inner, dict):
        v = inner.get("source_original_path")
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def _original_filename_for_import(src: str) -> str:
    """Destination basename under the order folder; matches server original.eml for .eml."""
    ext = os.path.splitext(src)[1].lower()
    if ext == ".txt":
        return "original.txt"
    if ext in (".html", ".htm"):
        return f"original{ext}"
    # .eml, staged *_.eml, default
    return "original.eml"


def _order_id_from_dict(row):
    if not isinstance(row, dict):
        return None
    for k in ("id", "order_id"):
        v = row.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    inner = row.get("order")
    if inner and isinstance(inner, dict):
        v = inner.get("id")
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def _eml_path_from_dict(row) -> str | None:
    if not isinstance(row, dict):
        return None
    v = row.get("eml_path")
    if v is not None and str(v).strip():
        return str(v).strip()
    inner = row.get("order")
    if inner and isinstance(inner, dict):
        v = inner.get("eml_path")
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def try_move_order_source_eml(row) -> bool:
    """
    If the order has source_eml_path + order_folder_path, mkdir the folder if needed,
    move that file to folder/original.* and PATCH eml_path + clear source_eml_path.
    Does not use inbox matching.
    """
    src = _source_eml_path_from_dict(row)
    folder = _order_folder_path_from_dict(row)
    oid = _order_id_from_dict(row)
    if not src or not folder or not oid:
        return False
    if not os.path.isfile(src):
        return False
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as e:
        print(f"[SOURCE_EML] mkdir failed {folder!r}: {e}")
        return False

    dest_name = _original_filename_for_import(src)
    dest = os.path.join(folder, dest_name)
    if os.path.isfile(dest) and not os.path.isfile(src):
        try:
            requests.patch(
                f"{ORDERS_API_URL}/{oid}",
                json={"source_eml_path": ""},
                timeout=15,
            )
        except Exception:
            pass
        return False

    existing_final = _eml_path_from_dict(row)
    if existing_final and os.path.isfile(existing_final):
        try:
            if os.path.normpath(existing_final) == os.path.normpath(dest):
                return False
        except Exception:
            pass

    try:
        shutil.move(src, dest)
        print(f"[SOURCE_EML] Moved {src} -> {dest} (order {oid})")
    except OSError as e:
        print(f"[SOURCE_EML] Move failed order {oid}: {e}")
        return False

    patch: dict = {"eml_path": dest, "source_eml_path": ""}
    orig = _source_original_path_from_dict(row)
    if orig:
        if os.path.isfile(orig):
            try:
                os.remove(orig)
                print(f"[SOURCE_EML] Removed original import file {orig}")
                patch["source_original_path"] = ""
            except OSError as e:
                print(f"[SOURCE_EML] Remove original failed {orig}: {e}")
                # leave source_original_path for a later poll retry
        else:
            patch["source_original_path"] = ""
    else:
        patch["source_original_path"] = ""

    try:
        url = f"{ORDERS_API_URL}/{oid}"
        r = requests.patch(url, json=patch, timeout=15)
        if not r.ok:
            print(f"[SOURCE_EML] PATCH {url} failed: {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"[SOURCE_EML] PATCH failed: {e}")
    return True


def try_cleanup_source_original(row) -> None:
    """Delete pending source_original_path when staged move already finished (e.g. retry after lock)."""
    if _source_eml_path_from_dict(row):
        return
    orig = _source_original_path_from_dict(row)
    if not orig:
        return
    oid = _order_id_from_dict(row)
    if not oid:
        return
    if not os.path.isfile(orig):
        try:
            requests.patch(
                f"{ORDERS_API_URL}/{oid}",
                json={"source_original_path": ""},
                timeout=15,
            )
        except Exception:
            pass
        return
    try:
        os.remove(orig)
        print(f"[SOURCE_EML] Removed original import file {orig} (cleanup)")
        requests.patch(
            f"{ORDERS_API_URL}/{oid}",
            json={"source_original_path": ""},
            timeout=15,
        )
    except OSError as e:
        print(f"[SOURCE_EML] Cleanup remove failed {orig}: {e}")


def process_source_eml_queue_loop():
    """Poll API for orders with pending source_eml_path; mkdir order folder if needed, then move file."""
    print("[SOURCE_EML] Loop started")
    while True:
        try:
            orders = _fetch_orders_for_matching()
            for row in orders:
                if not isinstance(row, dict):
                    continue
                if _source_eml_path_from_dict(row) and _order_folder_path_from_dict(row):
                    try_move_order_source_eml(row)
                elif _source_original_path_from_dict(row):
                    try_cleanup_source_original(row)
        except Exception as e:
            print(f"[SOURCE_EML] loop error: {e}")
        time.sleep(2)


def _try_patch_order_folder_path(row, folder_path: str) -> None:
    """Persist folder path on main order row so GET /orders stays in sync."""
    oid = row.get("id")
    if oid is None:
        return
    order_id = str(oid).strip()
    if not order_id:
        return
    url = f"{ORDERS_API_URL}/{order_id}"
    try:
        r = requests.patch(
            url,
            json={"order_folder_path": folder_path},
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        if not r.ok:
            print(f"[FOLDER] PATCH {url} failed: {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"[FOLDER] PATCH order_folder_path failed: {e}")


def move_eml_to_order_folder(filepath: str, folder_path: str, basename: str, row: dict | None = None) -> bool:
    ensure_folder(folder_path)
    dst = os.path.join(folder_path, basename)
    try:
        print(f"[MOVE] MOVING FILE: {filepath} -> {dst}")
        shutil.move(filepath, dst)
        print(f"[MOVED] {basename} -> {folder_path}")
        print(f"[EML PATH SAVED] {dst}")

        order_id = _order_id_from_dict(row) if isinstance(row, dict) else None
        if order_id:
            url = f"{ORDERS_API_URL}/{order_id}"
            patch = {
                "eml_path": dst,
                "source_eml_path": "",
            }
            try:
                r = requests.patch(
                    url,
                    json=patch,
                    headers={"Content-Type": "application/json"},
                    timeout=15,
                )
                if not r.ok:
                    print(f"[EML PATH SAVED] PATCH {url} failed: {r.status_code} {r.text[:200]}")
            except Exception as e:
                print(f"[EML PATH SAVED] PATCH failed for order {order_id}: {e}")
        return True
    except OSError as e:
        print(f"[ERROR] move match {basename}: {e}")
        return False


def _order_folder_path_from_dict(row):
    if not isinstance(row, dict):
        return None

    # direct
    if "order_folder_path" in row:
        v = row["order_folder_path"]
        if v is not None and str(v).strip():
            return str(v).strip()

    if "folder_path" in row:
        v = row["folder_path"]
        if v is not None and str(v).strip():
            return str(v).strip()

    # nested under "order"
    inner = row.get("order")
    if inner and isinstance(inner, dict):
        if "order_folder_path" in inner:
            v = inner["order_folder_path"]
            if v is not None and str(v).strip():
                return str(v).strip()
        if "folder_path" in inner:
            v = inner["folder_path"]
            if v is not None and str(v).strip():
                return str(v).strip()

    # alternate nesting (some payloads)
    data = row.get("data")
    if isinstance(data, dict):
        if "order_folder_path" in data:
            v = data["order_folder_path"]
            if v is not None and str(v).strip():
                return str(v).strip()
        if "folder_path" in data:
            v = data["folder_path"]
            if v is not None and str(v).strip():
                return str(v).strip()

    return None


def is_duplicate_order(order_number, orders):
    """True if any API row already uses this order_number (normalized)."""
    if not isinstance(orders, list):
        return False
    want = _normalize_order_number(order_number)
    if want is None:
        return False
    for row in orders:
        if not isinstance(row, dict):
            continue
        row_number = _order_number_from_dict(row)
        if _normalize_order_number(row_number) == want:
            return True
    return False


def _matching_order_folder_already_has_eml(order_number, orders) -> bool:
    """
    True if some on-disk order folder for this order_number already contains an .eml.
    Used so the first inbox file can still match after the order row exists in the API,
    while a second .eml is treated as a duplicate notification.
    """
    if not isinstance(orders, list):
        return False
    want = _normalize_order_number(order_number)
    if want is None:
        return False
    for row in orders:
        if not isinstance(row, dict):
            continue
        if _normalize_order_number(_order_number_from_dict(row)) != want:
            continue
        folder = _order_folder_path_from_dict(row)
        if not folder or not os.path.isdir(folder):
            continue
        try:
            for name in os.listdir(folder):
                if name.lower().endswith(".eml"):
                    return True
        except OSError:
            continue
    return False


def _eml_already_under_matching_order_folder(filepath, order_number, orders) -> bool:
    """If the file already lives under an order folder for this number, do not treat as duplicate drop."""
    if not isinstance(orders, list):
        return False
    want = _normalize_order_number(order_number)
    if want is None:
        return False
    try:
        norm_fp = os.path.normcase(os.path.normpath(filepath))
    except OSError:
        return False
    for row in orders:
        if not isinstance(row, dict):
            continue
        if _normalize_order_number(_order_number_from_dict(row)) != want:
            continue
        folder = _order_folder_path_from_dict(row)
        if not folder:
            continue
        try:
            norm_folder = os.path.normcase(os.path.normpath(folder))
            if norm_fp == norm_folder or norm_fp.startswith(norm_folder + os.sep):
                return True
        except (OSError, ValueError):
            continue
    return False


def _order_number_from_dict(row):
    if not isinstance(row, dict):
        return None

    # direct
    if "order_number" in row:
        v = row["order_number"]
        if v is not None:
            s = str(v).strip()
            if s:
                return s

    # nested under "order"
    inner = row.get("order")
    if inner and isinstance(inner, dict) and "order_number" in inner:
        v = inner["order_number"]
        if v is not None:
            s = str(v).strip()
            if s:
                return s

    # nested under "fields"
    fields = row.get("fields")
    if fields and isinstance(fields, dict) and "order_number" in fields:
        v = fields["order_number"]
        if v is not None:
            s = str(v).strip()
            if s:
                return s

    return None


def _fetch_orders_for_matching():
    """Fetch orders from the new backend only."""
    try:
        r = requests.get(ORDERS_API_URL, timeout=30)
        data = r.json()
        if isinstance(data, list):
            return data
    except Exception as e:
        print(f"[ERROR] GET {ORDERS_API_URL}: {e}")
    return []


def move_matching_eml(folder_path, order_number):
    if not os.path.exists(INBOX_PATH_STR):
        return

    for file in os.listdir(INBOX_PATH_STR):
        if not file.lower().endswith(".eml"):
            continue

        file_path = os.path.join(INBOX_PATH_STR, file)

        extracted = extract_order_number_from_filename(file)

        if not extracted:
            extracted = extract_order_number_from_eml(file_path)

        if extracted is not None and _normalize_order_number(extracted) == _normalize_order_number(
            order_number
        ):
            dst = os.path.join(folder_path, file)

            try:
                shutil.move(file_path, dst)
                print(f"[MOVED] {file} -> {folder_path}")
            except Exception as e:
                print(f"[ERROR] move match {file}: {e}")
            return  # stop after match


def move_to_duplicates(filepath):
    """Move a duplicate-inbox .eml into the duplicates folder (order already exists in API)."""
    os.makedirs(DUPLICATES_PATH_STR, exist_ok=True)

    filename = os.path.basename(filepath)
    base, ext = os.path.splitext(filename)
    target = os.path.join(DUPLICATES_PATH_STR, filename)
    n = 1
    while os.path.exists(target):
        target = os.path.join(DUPLICATES_PATH_STR, f"{base}_{n}{ext}")
        n += 1

    if os.path.exists(filepath):
        shutil.move(filepath, target)
        print(f"[DUPLICATE] {os.path.basename(target)} -> duplicates")


def move_to_unmatched(filepath):
    """Deprecated: leave unmatched files in Inbox so Spaila reflects Helper state."""
    if os.path.exists(filepath):
        print(f"[UNMATCHED] leaving file in Inbox: {os.path.basename(filepath)}")


def move_unmatched_emails():
    return


def process_single_file(filepath):
    """Try to match one inbox .eml to an order from the API and move it into the order folder.
    Returns True if the file was moved to an order folder, False otherwise."""
    global last_match_state
    filepath = os.path.normpath(filepath)

    print(f"[FILE EXISTS] {os.path.exists(filepath)} {filepath}")

    if not os.path.isfile(filepath):
        return False
    if not filepath.lower().endswith(".eml"):
        return False

    basename = os.path.basename(filepath)
    extracted = extract_order_number_from_filename(basename)
    if not extracted:
        extracted = extract_order_number_from_eml(filepath)
    if not extracted:
        print(f"[MATCH] NO MATCH FOUND: no order number extracted from {basename}")
        return False

    orders = _fetch_orders_for_matching()

    # Duplicate .eml: order exists AND its folder already has an .eml -> keep first, quarantine second
    if (
        is_duplicate_order(extracted, orders)
        and _matching_order_folder_already_has_eml(extracted, orders)
        and not _eml_already_under_matching_order_folder(filepath, extracted, orders)
    ):
        print(f"[DUPLICATE] Order already exists: {extracted}")
        move_to_duplicates(filepath)
        return True

    extracted_norm = _normalize_order_number(extracted)
    print(f"[MATCH] Looking for order #{extracted_norm}")

    order_found = False
    matched_folder = None
    matched_api_num = ""
    matched_order = None

    for order in orders:
        if not isinstance(order, dict):
            continue

        row_number = _order_number_from_dict(order)
        print(f"[COMPARE] extracted={extracted} vs row={row_number}")

        row_norm = _normalize_order_number(row_number)
        if row_norm is None or row_norm != extracted_norm:
            continue

        # Match on order number; folder may be filled later by API or created here.
        folder_path = _order_folder_path_from_dict(order)
        if not folder_path:
            print(f"[FOLDER] Missing folder path, creating...")
            folder_path = create_order_folder(order)
            if folder_path:
                print(f"[FOLDER CREATED] {folder_path}")
                _try_patch_order_folder_path(order, folder_path)
            else:
                print("[FOLDER] create_order_folder failed, trying next row")
                continue

        order_found = True
        matched_folder = folder_path
        matched_api_num = row_number
        matched_order = order
        print(f"[MATCH] MATCH FOUND: {matched_api_num}")
        break

    key = filepath
    prev = last_match_state.get(key)
    if prev is None or prev != order_found:
        print(
            f"[MATCH RESULT] Found: {order_found}"
            + (f" (folder={matched_folder!r}, api_order_number={matched_api_num!r})" if order_found else "")
        )
    last_match_state[key] = order_found

    if not order_found or not matched_folder:
        print(f"[MATCH] NO MATCH FOUND: {extracted_norm}")
        return False

    return move_eml_to_order_folder(filepath, matched_folder, basename, matched_order)


def process_pending_loop():
    import os

    UNMATCHED_TIMEOUT = 60  # seconds

    print("[PENDING] Loop started")

    while True:
        # Snapshot so we never mutate the set while iterating; fresh check each pass (no caching).
        for filepath in list(pending_files):
            # optional debug only (very noisy each poll)
            # print(f"[PENDING CHECK] {filepath}")
            norm = os.path.normpath(filepath)

            if not os.path.exists(filepath):
                print(f"[PENDING] Path gone, dropping from queue: {filepath}")
                pending_files.discard(filepath)
                pending_since.pop(norm, None)
                pending_since.pop(filepath, None)
                last_match_state.pop(norm, None)
                continue

            try:
                matched = process_single_file(filepath)
            except Exception as e:
                print(f"[PENDING ERROR] {e}")
                matched = False

            if matched:
                print(f"[PENDING] Matched and removing: {filepath}")
                pending_files.discard(filepath)
                pending_since.pop(norm, None)
                pending_since.pop(filepath, None)
                last_match_state.pop(norm, None)
                continue

            start_time = pending_since.get(norm) or pending_since.get(filepath)
            if start_time is None:
                pending_since[norm] = time.time()
                continue

            # --- UNMATCHED DISABLED (manual-only system) ---
            # Keeping for future use, but not active
            #
            # if time.time() - start_time > UNMATCHED_TIMEOUT:
            #     print(f"[UNMATCHED] Timeout reached: {filepath}")
            #     try:
            #         move_to_unmatched(filepath)
            #     except OSError as e:
            #         print(f"[UNMATCHED] move failed: {e}")
            #     pending_files.discard(filepath)
            #     pending_since.pop(norm, None)
            #     pending_since.pop(filepath, None)
            #     last_match_state.pop(norm, None)

        time.sleep(2)


class InboxHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return

        filepath = os.path.normpath(str(event.src_path))

        if not filepath.lower().endswith(".eml"):
            return

        # Only process new files; ignore snapshot from before observer started
        if filepath in initial_inbox_files:
            return

        if filepath in pending_files:
            return

        pending_files.add(filepath)
        pending_since[filepath] = time.time()
        initial_inbox_files.discard(filepath)
        print(f"[WATCHER] Registered (awaiting parse): {filepath}")


def start_watcher():
    global initial_inbox_files

    init_folders()

    path = INBOX_PATH_STR
    if not os.path.isdir(path):
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass

    inbox_path = Path(path)
    initial_inbox_files = set()   # kept empty — process existing files too
    queued_at_start = 0
    if inbox_path.is_dir():
        for p in inbox_path.glob("*.eml"):
            fp = os.path.normpath(str(p))
            if p.is_file() and fp not in pending_files:
                pending_files.add(fp)
                pending_since[fp] = time.time()
                queued_at_start += 1
    if queued_at_start:
        print(f"[INIT] Queued {queued_at_start} existing inbox file(s) for processing")
    else:
        print("[INIT] No existing inbox files to process")

    threading.Thread(target=process_pending_loop, daemon=True).start()
    threading.Thread(target=process_source_eml_queue_loop, daemon=True).start()

    watch_inbox = str(Path(path).resolve())

    event_handler = InboxHandler()
    observer = Observer()
    observer.schedule(event_handler, watch_inbox, recursive=False)

    observer.start()
    print(f"[WATCHER] Started monitoring inbox: {watch_inbox}")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()

    observer.join()


def run():
    """Queue inbox .eml files for process_pending_loop (skips initial snapshot files)."""
    global initial_inbox_files

    if not os.path.isdir(INBOX_PATH_STR):
        return
    for name in os.listdir(INBOX_PATH_STR):
        if not name.lower().endswith(".eml"):
            continue
        fp = os.path.normpath(os.path.join(INBOX_PATH_STR, name))
        if os.path.isfile(fp):
            if fp in initial_inbox_files:
                continue
            if fp in pending_files:
                continue
            pending_files.add(fp)
            pending_since[fp] = time.time()
            initial_inbox_files.discard(fp)
            print(f"[WATCHER] Registered (awaiting parse): {fp}")
    # TEMPORARY: disabled — unmatched was firing too early; re-enable after test
    # move_unmatched_emails()


if __name__ == "__main__":
    start_watcher()
