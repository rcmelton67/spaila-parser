"""
Fetch parser orders from the web app and create on-disk folders for each folder_path.

Usage (with server on localhost:5055):
  py helper/create_folders.py
"""

from __future__ import annotations

import os
import sys
from typing import Any

import requests

# Orders only — omits column_config (large) from GET /spaila/orders
API_URL = "http://localhost:5055/spaila/orders?include=orders"


def ensure_folder(path: str) -> None:
    if not path:
        return

    try:
        if not os.path.exists(path):
            os.makedirs(path, exist_ok=True)
            print(f"[CREATED] {path}")
        else:
            print(f"[EXISTS] {path}")
    except Exception as e:
        print(f"[ERROR] {path} -> {e}")


def _folder_path_from_order(order: dict[str, Any]) -> str:
    p = order.get("folder_path")
    if p is not None and str(p).strip():
        return str(p).strip()
    nested = order.get("order")
    if isinstance(nested, dict):
        p = nested.get("folder_path")
        if p is not None and str(p).strip():
            return str(p).strip()
    return ""


def main() -> int:
    try:
        r = requests.get(API_URL, timeout=60)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"[ERROR] GET {API_URL} -> {e}", file=sys.stderr)
        return 1

    data = r.json()
    orders = data.get("orders")
    if not isinstance(orders, list):
        print("[WARN] Response has no orders list", file=sys.stderr)
        return 1

    seen: set[str] = set()
    for order in orders:
        if not isinstance(order, dict):
            continue
        path = _folder_path_from_order(order)
        if not path or path in seen:
            continue
        seen.add(path)
        ensure_folder(path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
