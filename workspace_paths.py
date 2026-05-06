"""Spaila workspace path management — single source of truth for all Python processes.

Workspace root resolution order (first match wins):
  1. Environment variable SPAILA_WORKSPACE_ROOT (testing / CI override)
  2. workspace_config.json in the OS app-config directory
  3. Legacy C:/Spaila (Windows) / ~/Spaila (other) — if it already exists with data
  4. Default new location: ~/Spaila  (home dir, cross-platform)

workspace_config.json location:
  Windows : %APPDATA%/Spaila/workspace_config.json
  Other   : ~/.config/Spaila/workspace_config.json

Internal layout under <root>/.spaila_internal/:
  All system JSON/config files, support reports, logs, email archives.

User-visible layout under <root>/:
  Inbox/  Orders/  Archive/  Backup/  Sent/  Docs/
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict

log = logging.getLogger(__name__)

WorkspaceMap = Dict[str, Path]
Logger = Callable[[str], None]

CONFIG_VERSION = "2"

# ── Config directory (stores workspace_config.json, NOT inside the workspace) ─

def _config_dir() -> Path:
    """OS app-config directory for Spaila settings (not the workspace itself)."""
    if os.name == "nt":
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
        return Path(appdata) / "Spaila"
    return Path.home() / ".config" / "Spaila"


def _config_path() -> Path:
    return _config_dir() / "workspace_config.json"


def _read_config() -> dict:
    cp = _config_path()
    if cp.is_file():
        try:
            return json.loads(cp.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _write_config(root: Path, migration_version: str = "0") -> None:
    cd = _config_dir()
    cd.mkdir(parents=True, exist_ok=True)
    cfg = {
        "workspace_root":    str(root).replace("\\", "/"),
        "initialized_version": CONFIG_VERSION,
        "migration_version": migration_version,
        "created_at":        datetime.now(timezone.utc).isoformat(),
    }
    existing = _read_config()
    if existing:
        cfg["created_at"] = existing.get("created_at", cfg["created_at"])
    (_config_dir() / "workspace_config.json").write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ── Workspace root ─────────────────────────────────────────────────────────────

def get_workspace_root() -> Path:
    # 1. Explicit env override (CI / testing)
    env_root = os.environ.get("SPAILA_WORKSPACE_ROOT", "").strip()
    if env_root:
        return Path(env_root)

    # 2. Persisted config
    cfg = _read_config()
    if cfg.get("workspace_root"):
        return Path(cfg["workspace_root"])

    # 3. Legacy default location — only if it has actual data
    # An empty C:\Spaila recreated by old code after a manual move is ignored.
    if os.name == "nt":
        legacy = Path("C:/Spaila")
    else:
        legacy = Path.home() / "Spaila"

    if legacy.exists() and _legacy_root_has_data(legacy):
        _write_config(legacy, migration_version="0")
        return legacy

    # 4. New default: ~/Spaila  (home dir — avoids OneDrive/cloud-sync redirection)
    default = Path.home() / "Spaila"
    _write_config(default, migration_version="1")
    return default


def _legacy_root_has_data(legacy: Path) -> bool:
    """Return True only if the legacy root has actual user data (not an empty skeleton)."""
    markers = ["Orders", "Archive", "Inbox", "inbox", "Backup", "Sent", "Docs"]
    for name in markers:
        sub = legacy / name
        try:
            if sub.exists() and any(sub.iterdir()):
                return True
        except OSError:
            pass
    json_markers = ["helper_settings.json", "email_settings.json", "hidden_emails.json"]
    for name in json_markers:
        if (legacy / name).is_file():
            return True
    internal = legacy / ".spaila_internal"
    try:
        if internal.exists() and any(internal.iterdir()):
            return True
    except OSError:
        pass
    return False


def get_workspace_dirs() -> WorkspaceMap:
    root = get_workspace_root()
    internal = root / ".spaila_internal"
    return {
        # ── User-visible folders ───────────────────────────────────────────
        "root":     root,
        "Inbox":    root / "Inbox",          # user-facing capitalised label
        "Orders":   root / "Orders",
        "Archive":  root / "Archive",
        "Backup":   root / "Backup",
        "Sent":     root / "Sent",           # was root/"sent" (lowercase)
        "Docs":     root / "Docs",           # was hardcoded C:\Spaila\Docs
        # ── Internal / system ──────────────────────────────────────────────
        "Internal": internal,
        "InboxModule": root / "Inbox",
        "InboxNew":    root / "Inbox",
        "InboxCur":    root / "Inbox",
        # Recovery sub-folders (inside internal)
        "Duplicates": internal / "duplicates",
        "Unmatched":  internal / "unmatched",
        # ── System JSON files (all inside .spaila_internal/) ──────────────
        "HelperSettings":         internal / "helper_settings.json",
        "EmailSettings":          internal / "email_settings.json",
        "OrderEmailLearning":     internal / "order_email_learning.json",
        "HiddenEmails":           internal / "hidden_emails.json",
        "WorkspaceInboxHidden":   internal / "workspace_inbox_hidden.json",
        "ProcessedInboxRefs":     internal / ".processedInboxRefs.json",
        "OrderArchiveSettings":   internal / "order_archive_settings.json",
        "SentMessages":           internal / "sent_messages.json",
        # ── Support reports ───────────────────────────────────────────────
        "SupportReports": internal / "support_reports",
    }


def _unique_path(target_path: Path) -> Path:
    if not target_path.exists():
        return target_path
    suffix = 1
    while True:
        candidate = target_path.with_name(
            f"{target_path.stem}__migrated{suffix}{target_path.suffix}"
        )
        if not candidate.exists():
            return candidate
        suffix += 1


def _migrate_legacy_recovery_folder(
    root: Path, legacy_name: str, internal_path: Path, logger: Logger
) -> None:
    legacy_path = root / legacy_name
    if not legacy_path.exists():
        return
    internal_path.mkdir(parents=True, exist_ok=True)
    migrated = 0
    try:
        for entry in legacy_path.iterdir():
            entry.rename(_unique_path(internal_path / entry.name))
            migrated += 1
        if migrated:
            logger(f"[WORKSPACE] migrated {migrated} file(s) from {legacy_path} -> {internal_path}")
        if not any(legacy_path.iterdir()):
            legacy_path.rmdir()
            logger(f"[WORKSPACE] removed empty legacy recovery folder: {legacy_path}")
        else:
            logger(f"[WORKSPACE] legacy recovery folder retained with non-file entries: {legacy_path}")
    except OSError as error:
        logger(f"[WORKSPACE] recovery migration failed for {legacy_path}: {error}")


def _migrate_root_json_files(dirs: WorkspaceMap, logger: Logger) -> None:
    """Move system JSON files from workspace root → .spaila_internal/ if they exist there."""
    root = dirs["root"]
    internal = dirs["Internal"]

    # (old_root_filename, internal_key)
    migrations = [
        ("helper_settings.json",       "HelperSettings"),
        ("email_settings.json",        "EmailSettings"),
        ("order_email_learning.json",  "OrderEmailLearning"),
        ("hidden_emails.json",         "HiddenEmails"),
        ("workspace_inbox_hidden.json","WorkspaceInboxHidden"),
        (".processedInboxRefs.json",   "ProcessedInboxRefs"),
        ("order_archive_settings.json","OrderArchiveSettings"),
        ("sent_messages.json",         "SentMessages"),
    ]
    for filename, key in migrations:
        src = root / filename
        dst = dirs[key]
        if src.is_file() and not dst.is_file():
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dst)
                logger(f"[WORKSPACE] migrated {filename} -> .spaila_internal/")
            except OSError as e:
                logger(f"[WORKSPACE] could not migrate {filename}: {e}")
        elif src.is_file() and dst.is_file():
            logger(f"[WORKSPACE] {filename} already exists in .spaila_internal/, leaving root copy")


def _move_folder_contents(src: Path, dst: Path, logger: Logger, log_lines: list) -> int:
    """Move every item inside src into dst, merging if dst already exists.
    Returns number of errors."""
    errors = 0
    for item in src.iterdir():
        target = dst / item.name
        if target.exists():
            if item.is_dir() and target.is_dir():
                # Recurse to merge nested directories
                errors += _move_folder_contents(item, target, logger, log_lines)
            else:
                log_lines.append(f"    skip {item.name}: already at destination")
        else:
            try:
                item.rename(target)
                log_lines.append(f"    merged {item.name}")
            except OSError:
                try:
                    if item.is_dir():
                        shutil.copytree(str(item), str(target))
                        shutil.rmtree(str(item), ignore_errors=True)
                    else:
                        shutil.copy2(str(item), str(target))
                        item.unlink(missing_ok=True)
                    log_lines.append(f"    merged (cross-drive) {item.name}")
                except (OSError, shutil.Error) as e:
                    log_lines.append(f"    ERROR merging {item.name}: {e}")
                    errors += 1
    return errors


def move_workspace(old_root: Path, new_root: Path, logger: Logger) -> dict:
    """Move all workspace content from old_root to new_root.

    Handles both same-drive (fast rename) and cross-drive (copy+delete) moves.
    When a folder already exists at the destination (e.g. created by startup layout
    as an empty skeleton), its contents are merged instead of skipped.
    Never deletes source until destination is verified.
    Returns {"ok": bool, "errors": int}.
    """
    folders = ["Inbox", "inbox", "Orders", "Archive", "Backup", "Sent", "sent", "Docs", ".spaila_internal"]
    log_lines: list[str] = []
    errors = 0

    new_root.mkdir(parents=True, exist_ok=True)

    for name in folders:
        src = old_root / name
        dst = new_root / name
        if not src.exists():
            continue
        if dst.exists():
            # Destination exists (likely empty skeleton from startup layout).
            # Merge contents rather than skipping entirely so no files are stranded.
            log_lines.append(f"  merge {name}: destination exists, merging contents")
            logger(f"[WORKSPACE] merging {name} contents into existing destination")
            errs = _move_folder_contents(src, dst, logger, log_lines)
            errors += errs
            if errs == 0:
                # Remove the now-empty source directory
                try:
                    if not any(src.iterdir()):
                        src.rmdir()
                except OSError:
                    pass
            continue
        try:
            src.rename(dst)
            log_lines.append(f"  moved {name}: {src} -> {dst}")
            logger(f"[WORKSPACE] moved {name}")
        except OSError:
            # Cross-drive or locked: fall back to copy+delete
            try:
                shutil.copytree(str(src), str(dst))
                shutil.rmtree(str(src), ignore_errors=True)
                log_lines.append(f"  copied+removed {name} (cross-drive): {src} -> {dst}")
                logger(f"[WORKSPACE] cross-drive move {name}")
            except (OSError, shutil.Error) as e:
                log_lines.append(f"  ERROR moving {name}: {e}")
                logger(f"[WORKSPACE] ERROR moving {name}: {e}")
                errors += 1

    # Write migration log
    try:
        log_dir = new_root / ".spaila_internal" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        log_file = log_dir / f"migration_{stamp}.log"
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now(timezone.utc).isoformat()}] Workspace moved: {old_root} -> {new_root}\n")
            f.write("\n".join(log_lines) + "\n")
            msg = f"  {errors} error(s) occurred" if errors else "  completed without errors"
            f.write(msg + "\n")
        logger(f"[WORKSPACE] migration log written: {log_file}")
    except OSError:
        pass

    return {"ok": errors == 0, "errors": errors}


def _migrate_legacy_workspace(root: Path, legacy_root: Path, logger: Logger) -> None:
    """Wrapper for legacy C:\\Spaila detection in ensure_workspace_layout."""
    move_workspace(legacy_root, root, logger)


def ensure_workspace_layout(log: Logger | None = None) -> WorkspaceMap:
    logger = log or (lambda _: None)
    dirs = get_workspace_dirs()
    root = dirs["root"]

    root.mkdir(parents=True, exist_ok=True)
    dirs["Internal"].mkdir(parents=True, exist_ok=True)

    # Hide .spaila_internal on Windows
    if os.name == "nt":
        try:
            subprocess.run(
                ["attrib", "+h", str(dirs["Internal"])],
                check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except OSError:
            pass

    # ── Legacy capitalization fixes (lowercase → Title, Windows-safe) ─────────
    # On Windows the filesystem is case-insensitive, so Path("orders").exists()
    # returns True even when the on-disk name is "Orders".  We must inspect the
    # actual directory listing to detect a case mismatch and perform a two-step
    # rename (old → temp → new) to change only the casing.
    legacy_pairs = {
        "inbox":   "Inbox",
        "orders":  "Orders",
        "archive": "Archive",
        "backup":  "Backup",
        "sent":    "Sent",
        "docs":    "Docs",
    }
    try:
        root_entries = {e.name.lower(): e.name for e in root.iterdir() if e.is_dir()}
    except OSError:
        root_entries = {}

    for legacy_lower, canonical_name in legacy_pairs.items():
        actual_name = root_entries.get(legacy_lower)
        if actual_name is None:
            continue  # folder doesn't exist at all — will be created below
        if actual_name == canonical_name:
            continue  # already correct case
        # Case-only rename: two-step via temp to satisfy case-insensitive filesystems
        actual_path = root / actual_name
        tmp_path    = root / f"__spaila_tmp_rename__{actual_name}__"
        canonical_path = root / canonical_name
        try:
            actual_path.rename(tmp_path)
            tmp_path.rename(canonical_path)
            logger(f"[WORKSPACE] case-renamed {actual_name} -> {canonical_name}")
        except OSError as error:
            logger(f"[WORKSPACE] case-rename failed {actual_name} -> {canonical_name}: {error}")
            try:
                if tmp_path.exists():
                    tmp_path.rename(actual_path)
            except OSError:
                pass

    # ── Month subfolder capitalisation (orders/2026/april → 2026/April) ───────
    orders_dir = root / "Orders"
    if orders_dir.is_dir():
        for year_dir in orders_dir.iterdir():
            if not year_dir.is_dir() or not year_dir.name.isdigit():
                continue
            try:
                month_entries = {e.name.lower(): e for e in year_dir.iterdir() if e.is_dir()}
            except OSError:
                continue
            for mo_lower, mo_path in month_entries.items():
                # Title-case the month name (e.g. "april" → "April")
                canonical_mo = mo_lower.capitalize()
                if mo_path.name == canonical_mo:
                    continue  # already correct
                canonical_mo_path = year_dir / canonical_mo
                tmp_mo = year_dir / f"__spaila_tmp_rename__{mo_path.name}__"
                try:
                    mo_path.rename(tmp_mo)
                    tmp_mo.rename(canonical_mo_path)
                    logger(f"[WORKSPACE] case-renamed month {mo_path.name} -> {canonical_mo}")
                except OSError as error:
                    logger(f"[WORKSPACE] month case-rename failed {mo_path.name}: {error}")
                    try:
                        if tmp_mo.exists():
                            tmp_mo.rename(mo_path)
                    except OSError:
                        pass

    # ── Recovery folder migration (Duplicates/Unmatched → internal) ──────────
    _migrate_legacy_recovery_folder(root, "Duplicates", dirs["Duplicates"], logger)
    _migrate_legacy_recovery_folder(root, "duplicates", dirs["Duplicates"], logger)
    _migrate_legacy_recovery_folder(root, "Unmatched",  dirs["Unmatched"],  logger)
    _migrate_legacy_recovery_folder(root, "unmatched",  dirs["Unmatched"],  logger)

    deprecated_paths = [root / "Processed", root / "processed"]
    for dep in deprecated_paths:
        if dep.exists():
            logger(f"[WORKSPACE] legacy folder left in place: {dep}")

    # ── Legacy workspace root migration (C:\Spaila → Documents/Spaila) ───────
    cfg = _read_config()
    migration_version = cfg.get("migration_version", "0")
    if migration_version == "0" and os.name == "nt":
        legacy_root = Path("C:/Spaila")
        if legacy_root.exists() and legacy_root.resolve() != root.resolve():
            logger(f"[WORKSPACE] migrating legacy workspace {legacy_root} -> {root}")
            _migrate_legacy_workspace(root, legacy_root, logger)
            _write_config(root, migration_version="1")

    # ── Root JSON → .spaila_internal/ migration ───────────────────────────────
    _migrate_root_json_files(dirs, logger)

    # ── Ensure all directories exist ──────────────────────────────────────────
    for key, folder in dirs.items():
        if key == "root" or not str(folder).endswith((".json",)):
            if not key.endswith(("Settings", "Refs", "Learning", "Hidden", "Messages", "Reports")) \
               and key not in ("ProcessedInboxRefs", "SentMessages"):
                folder.mkdir(parents=True, exist_ok=True)

    # Explicitly create the key directories
    for key in ("Inbox", "InboxModule", "Orders", "Archive", "Backup", "Sent", "Docs",
                "Internal", "Duplicates", "Unmatched", "SupportReports"):
        dirs[key].mkdir(parents=True, exist_ok=True)

    return dirs
