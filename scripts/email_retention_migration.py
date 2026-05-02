from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.inbox import email_archive
from workspace_paths import get_workspace_dirs


def _load_processed_refs(root: Path) -> set[str]:
    path = root / ".processedInboxRefs.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    if isinstance(data, list):
        return {str(item) for item in data if str(item or "").strip()}
    if isinstance(data, dict):
        refs = data.get("refs") or data.get("processed_refs") or data.get("items")
        if isinstance(refs, list):
            return {str(item) for item in refs if str(item or "").strip()}
    return set()


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy verified processed inbox emails into the hidden retention archive.")
    parser.add_argument("--workspace-root", help="Workspace root to scan. Required unless --allow-live-workspace is set.")
    parser.add_argument("--allow-live-workspace", action="store_true", help="Allow using the default C:/Spaila workspace.")
    parser.add_argument("--apply", action="store_true", help="Copy files into the hidden archive. Default is dry-run.")
    parser.add_argument("--grace-days", type=int, default=14, help="Retention grace period for later cleanup planning.")
    parser.add_argument("--processed-ref", action="append", default=[], help="Additional processed inbox ref/path to include.")
    args = parser.parse_args()

    if args.workspace_root:
        root = Path(args.workspace_root).resolve()
        internal = root / ".spaila_internal"
        dirs = {
            "root": root,
            "Internal": internal,
            "InboxModule": root / "inbox",
        }
        email_archive._INTERNAL_DIR = internal
        email_archive._EMAIL_ARCHIVE_DIR = internal / "email_archive"
        email_archive._RETENTION_INDEX_PATH = internal / "email_retention_index.json"
    else:
        if not args.allow_live_workspace:
            parser.error("--workspace-root is required for safety, or pass --allow-live-workspace intentionally.")
        dirs = get_workspace_dirs()
    refs = _load_processed_refs(dirs["root"])
    refs.update(str(item) for item in args.processed_ref if str(item or "").strip())
    result = email_archive.migrate_processed_inbox_files(
        dirs["InboxModule"],
        refs,
        dry_run=not args.apply,
        grace_days=args.grace_days,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
