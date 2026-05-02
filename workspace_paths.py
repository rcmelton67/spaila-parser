from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable, Dict


WorkspaceMap = Dict[str, Path]
Logger = Callable[[str], None]


def get_workspace_root() -> Path:
    if os.name == "nt":
        return Path("C:/Spaila")
    return Path.home() / "Spaila"


def get_workspace_dirs() -> WorkspaceMap:
    root = get_workspace_root()
    internal = root / ".spaila_internal"
    return {
        "root": root,
        "Internal": internal,
        "Inbox": root / "Inbox",
        "InboxModule": root / "inbox",
        "InboxNew": root / "inbox",
        "InboxCur": root / "inbox",
        "Orders": root / "Orders",
        "Archive": root / "Archive",
        "Backup": root / "Backup",
        "Duplicates": internal / "duplicates",
        "Unmatched": internal / "unmatched",
    }


def _unique_path(target_path: Path) -> Path:
    if not target_path.exists():
        return target_path
    suffix = 1
    while True:
        candidate = target_path.with_name(f"{target_path.stem}__migrated{suffix}{target_path.suffix}")
        if not candidate.exists():
            return candidate
        suffix += 1


def _migrate_legacy_recovery_folder(root: Path, legacy_name: str, internal_path: Path, logger: Logger) -> None:
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


def ensure_workspace_layout(log: Logger | None = None) -> WorkspaceMap:
    logger = log or (lambda _message: None)
    dirs = get_workspace_dirs()
    root = dirs["root"]
    root.mkdir(parents=True, exist_ok=True)
    dirs["Internal"].mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        try:
            subprocess.run(["attrib", "+h", str(dirs["Internal"])], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass

    legacy_pairs = {
        "orders": "Orders",
        "archive": "Archive",
        "backup": "Backup",
    }

    for legacy_name, canonical_name in legacy_pairs.items():
        legacy_path = root / legacy_name
        canonical_path = dirs[canonical_name]
        try:
            if legacy_path.exists() and not canonical_path.exists():
                legacy_path.rename(canonical_path)
                logger(f"[WORKSPACE] renamed {legacy_path} -> {canonical_path}")
            elif legacy_path.exists() and canonical_path.exists():
                logger(
                    f"[WORKSPACE] rename skipped for {legacy_path} because {canonical_path} already exists"
                )
        except OSError as error:
            logger(f"[WORKSPACE] rename failed for {legacy_path}: {error}")

    _migrate_legacy_recovery_folder(root, "Duplicates", dirs["Duplicates"], logger)
    _migrate_legacy_recovery_folder(root, "duplicates", dirs["Duplicates"], logger)
    _migrate_legacy_recovery_folder(root, "Unmatched", dirs["Unmatched"], logger)
    _migrate_legacy_recovery_folder(root, "unmatched", dirs["Unmatched"], logger)

    deprecated_paths = [root / "Processed", root / "processed"]
    for deprecated_path in deprecated_paths:
        if deprecated_path.exists():
            logger(f"[WORKSPACE] legacy folder left in place: {deprecated_path}")

    for key, folder in dirs.items():
        if key == "root":
            continue
        folder.mkdir(parents=True, exist_ok=True)

    return dirs
