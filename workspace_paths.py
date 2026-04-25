from __future__ import annotations

import os
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
    return {
        "root": root,
        "Inbox": root / "Inbox",
        "InboxModule": root / "inbox",
        "InboxNew": root / "inbox",
        "InboxCur": root / "inbox",
        "Orders": root / "Orders",
        "Duplicates": root / "Duplicates",
        "Archive": root / "Archive",
        "Backup": root / "Backup",
    }


def ensure_workspace_layout(log: Logger | None = None) -> WorkspaceMap:
    logger = log or (lambda _message: None)
    dirs = get_workspace_dirs()
    root = dirs["root"]
    root.mkdir(parents=True, exist_ok=True)

    legacy_pairs = {
        "orders": "Orders",
        "duplicates": "Duplicates",
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

    deprecated_paths = [root / "Processed", root / "processed", root / "unmatched", root / "Unmatched"]
    for deprecated_path in deprecated_paths:
        if deprecated_path.exists():
            logger(f"[WORKSPACE] legacy folder left in place: {deprecated_path}")

    for key, folder in dirs.items():
        if key == "root":
            continue
        folder.mkdir(parents=True, exist_ok=True)

    return dirs
