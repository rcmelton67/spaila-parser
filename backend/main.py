import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from .orders import router as orders_router
from .db import init_db
from server.inbox.inbox_routes import router as inbox_router
from server.inbox.mail_service import mail_service
from workspace_paths import ensure_workspace_layout
import json as _json
import os as _os

# Project root (…/spaila-parser) — never depend on process cwd for learning files.
_PROJECT_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))

app = FastAPI(title="Spaila Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(orders_router)
app.include_router(inbox_router)


@app.on_event("startup")
def startup():
    init_db()
    ensure_workspace_layout()
    mail_service.start(auto=True)

    # ── Count every learning store precisely (absolute paths; no cwd drift) ───
    def _load_json(path: str) -> dict:
        try:
            with open(path, encoding="utf-8") as f:
                return _json.load(f)
        except Exception:
            return {}

    learn_path = _os.path.join(_PROJECT_ROOT, "parser", "learning", "learning_store.json")
    store = _load_json(learn_path)
    assignments = sum(1 for recs in store.values() for r in recs if r.get("type") == "assign")
    rejections  = sum(1 for recs in store.values() for r in recs if r.get("type") == "reject")

    def _flat_count(path: str) -> int:
        try:
            return len(_json.load(open(path, encoding="utf-8")))
        except Exception:
            return 0

    def _learning_count(path: str) -> int:
        try:
            data = _json.load(open(path, encoding="utf-8"))
            return sum(len(recs) for recs in data.values())
        except Exception:
            return 0

    anchors             = _learning_count(_os.path.join(_PROJECT_ROOT, "parser", "anchors", "anchor_store.json"))
    replay              = _flat_count(_os.path.join(_PROJECT_ROOT, "parser", "replay",   "replay_store.json"))
    confidence_records  = _flat_count(_os.path.join(_PROJECT_ROOT, "parser", "learning", "confidence_store.json"))

    print(
        "RESET_VERIFICATION {\n"
        f"    assignments:        {assignments},\n"
        f"    rejections:         {rejections},\n"
        f"    anchors:            {anchors},\n"
        f"    replay:             {replay},\n"
        f"    confidence_records: {confidence_records}\n"
        "}",
        file=sys.stderr, flush=True,
    )

    total = assignments + rejections + anchors + replay + confidence_records
    if total > 0:
        nonzero = [
            k for k, v in (
                ("assignments",        assignments),
                ("rejections",         rejections),
                ("anchors",            anchors),
                ("replay",             replay),
                ("confidence_records", confidence_records),
            ) if v > 0
        ]
        # Print loudly but do NOT raise — crashing the backend hangs every UI
        # fetch call and freezes the ❌ buttons permanently.
        print("", file=sys.stderr, flush=True)
        print("=" * 60, file=sys.stderr, flush=True)
        print("ERROR: RESET FAILED", file=sys.stderr, flush=True)
        print(
            f"  {total} record(s) remain in: {', '.join(nonzero)}",
            file=sys.stderr, flush=True,
        )
        print("  Run: py reset_learning.py", file=sys.stderr, flush=True)
        print("=" * 60, file=sys.stderr, flush=True)
        print("", file=sys.stderr, flush=True)


@app.on_event("shutdown")
def shutdown():
    mail_service.stop(reason="app_shutdown")


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")


@app.get("/health")
async def health():
    return {"status": "ok"}
