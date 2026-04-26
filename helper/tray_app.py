"""
System tray UI for helper/sync_folders.py — start/stop, restart, log panel.

Run from repo root:
  py helper/tray_app.py

Dependencies:
  pip install -r helper/tray_requirements.txt
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from PIL import Image
from pystray import Icon, Menu, MenuItem
import tkinter as tk
from tkinterdnd2 import DND_FILES, TkinterDnD
from workspace_paths import ensure_workspace_layout

# Repo root (parent of helper/)
_SYNC_FOLDERS = Path(__file__).resolve().parent / "sync_folders.py"
_WORKSPACE_DIRS = ensure_workspace_layout(print)
BASE_PATH = _WORKSPACE_DIRS["root"]
INBOX_PATH_STR = str(_WORKSPACE_DIRS["Inbox"])

ICON_PATH = r"C:\Users\rcmel\dev\email_extractor\ui_electron\src\assets\branding\spaila-logo.blue.ico"
_ICON_FALLBACK = _ROOT / "ui_electron" / "src" / "assets" / "branding" / "spaila-logo.blue.ico"


def _resolved_icon_path() -> str:
    if Path(ICON_PATH).is_file():
        return ICON_PATH
    if _ICON_FALLBACK.is_file():
        return str(_ICON_FALLBACK)
    return ICON_PATH

helper_process: subprocess.Popen | None = None
log_lines: list[str] = []
_log_lock = threading.Lock()

status_text = "Starting..."
last_action = ""

_ACTION_LINE_TAGS = ("[MOVED]", "[DUPLICATE]", "[WATCHER] Registered")


def start_helper() -> None:
    global helper_process

    if helper_process and helper_process.poll() is None:
        return

    if not _SYNC_FOLDERS.is_file():
        with _log_lock:
            log_lines.append(f"[tray] Missing script: {_SYNC_FOLDERS}")
        return

    print("[tray] starting helper...")

    helper_process = subprocess.Popen(
        [sys.executable, str(_SYNC_FOLDERS)],
        cwd=str(_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    threading.Thread(target=read_logs, daemon=True).start()


def stop_helper() -> None:
    global helper_process

    if helper_process:
        try:
            if helper_process.poll() is None:
                helper_process.kill()
                helper_process.wait(timeout=2)
        except Exception as e:
            print(f"[tray] error killing helper: {e}")

        helper_process = None


def restart_helper(icon=None, item=None) -> None:
    print("[tray] restarting helper...")

    stop_helper()

    time.sleep(0.5)

    start_helper()


def read_logs() -> None:
    global helper_process, last_action
    proc = helper_process
    if proc is None or proc.stdout is None:
        return
    try:
        for line in proc.stdout:
            if not line:
                break
            clean = line.strip()
            with _log_lock:
                log_lines.append(clean)
                if any(tag in clean for tag in _ACTION_LINE_TAGS):
                    last_action = clean
                if len(log_lines) > 100:
                    log_lines.pop(0)
    except Exception as e:
        with _log_lock:
            log_lines.append(f"[tray] log reader: {e}")
    finally:
        with _log_lock:
            log_lines.append("[tray] helper stdout closed")


def get_counts() -> int:
    inbox = _WORKSPACE_DIRS["Inbox"]

    inbox_count = len(list(inbox.glob("*.eml"))) if inbox.exists() else 0

    return inbox_count


def create_icon() -> Image.Image:
    icon_path = _resolved_icon_path()
    try:
        return Image.open(icon_path)
    except Exception:
        # No .ico file found — generate a simple coloured square as fallback
        img = Image.new("RGBA", (64, 64), (37, 99, 235, 255))   # blue square
        return img


def _quit_app(window: tk.Misc, icon: Icon) -> None:
    stop_helper()
    window.after(0, window.quit)
    icon.stop()


def add_to_startup() -> None:
    appdata = os.getenv("APPDATA")
    if not appdata:
        print("[startup] APPDATA not set; skipping")
        return

    startup_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    startup_dir.mkdir(parents=True, exist_ok=True)

    target = Path(__file__).resolve()
    shortcut_path = startup_dir / "Spaila Helper.bat"

    with open(shortcut_path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("@echo off\n")
        f.write(f'cd /d "{target.parent}"\n')
        f.write(f'"{sys.executable}" "{target}"\n')

    print(f"[startup] added: {shortcut_path}")


def remove_from_startup() -> None:
    appdata = os.getenv("APPDATA")
    if not appdata:
        return

    startup_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    shortcut_path = startup_dir / "Spaila Helper.bat"

    if shortcut_path.exists():
        shortcut_path.unlink()
        print("[startup] removed")


def main() -> None:
    """
    Tk (and Windows OLE drag-and-drop) must run on the main thread. The tray icon runs in a daemon thread.
    """
    start_helper()

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("spaila.helper.app")
    except Exception:
        pass

    window = TkinterDnD.Tk()
    window.title("Spaila Helper")
    window.withdraw()

    try:
        window.iconbitmap(_resolved_icon_path())
    except Exception as e:
        print(f"[tray] icon load failed: {e}")

    def handle_drop(event):
        files = window.tk.splitlist(event.data)
        os.makedirs(INBOX_PATH_STR, exist_ok=True)
        for filepath in files:
            if filepath.lower().endswith(".eml"):
                print(f"[DROP] {filepath}")
                target = os.path.join(INBOX_PATH_STR, os.path.basename(filepath))
                shutil.copy(filepath, target)
                print(f"[DROP] copied to inbox: {target}")
                with _log_lock:
                    log_lines.append(f"[DROP] copied to inbox: {target}")
                    if len(log_lines) > 100:
                        log_lines.pop(0)
            else:
                with _log_lock:
                    log_lines.append(f"[DROP] skipped (not .eml): {filepath}")
                    if len(log_lines) > 100:
                        log_lines.pop(0)

    window.drop_target_register(DND_FILES)
    window.dnd_bind("<<Drop>>", handle_drop)

    status_label = tk.Label(window, text="", anchor="w")
    status_label.pack(fill="x", padx=6, pady=(6, 2))

    counts_label = tk.Label(window, text="", anchor="w")
    counts_label.pack(fill="x", padx=6, pady=2)

    hint_label = tk.Label(
        window,
        text="Drag .eml files from File Explorer onto this window. (Dragging mail from Outlook does not supply files.)",
        anchor="w",
        wraplength=640,
        fg="#555",
        font=("Segoe UI", 9),
    )
    hint_label.pack(fill="x", padx=6, pady=(0, 4))

    last_label = tk.Label(window, text="", anchor="w")
    last_label.pack(fill="x", padx=6, pady=(2, 6))

    text = tk.Text(window, height=15, width=80, font=("Consolas", 9))
    text.pack(fill=tk.BOTH, expand=True, padx=6, pady=(0, 6))
    text.drop_target_register(DND_FILES)
    text.dnd_bind("<<Drop>>", handle_drop)

    def refresh() -> None:
        global status_text
        if not window.winfo_exists():
            return

        if helper_process is not None and helper_process.poll() is None:
            status_text = "Running"
        else:
            status_text = "Stopped"

        inbox_count = get_counts()

        with _log_lock:
            tail = list(log_lines[-50:])
            la = last_action

        status_label.config(text=f"Status: {status_text}")
        counts_label.config(text=f"Inbox: {inbox_count} .eml")
        last_label.config(text=f"Last: {la}" if la else "Last: (none)")

        text.delete(1.0, tk.END)
        for line in tail:
            text.insert(tk.END, line + "\n")

        window.after(1000, refresh)

    refresh()

    window.protocol("WM_DELETE_WINDOW", window.withdraw)

    def show_panel(icon=None, item=None) -> None:
        def _show() -> None:
            window.deiconify()
            window.lift()
            try:
                window.attributes("-topmost", True)
                window.attributes("-topmost", False)
            except Exception:
                pass

        window.after(0, _show)

    tray_icon = Icon(
        "Spaila",
        create_icon(),
        "Spaila Helper",
        menu=Menu(
            MenuItem("Open Panel", show_panel),
            MenuItem("Restart Helper", restart_helper),
            MenuItem("Enable Auto-Start", lambda icon, item: add_to_startup()),
            MenuItem("Disable Auto-Start", lambda icon, item: remove_from_startup()),
            MenuItem("Exit", lambda icon, item: _quit_app(window, icon)),
        ),
    )

    threading.Thread(target=tray_icon.run, daemon=True).start()
    window.mainloop()


if __name__ == "__main__":
    main()
