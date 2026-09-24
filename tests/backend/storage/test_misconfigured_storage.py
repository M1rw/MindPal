# tests/backend/storage/test_misconfigured_storage.py - a missing storage setting must not take the site down
"""Production once selected Supabase without SUPABASE_URL set. The store raised
at import, so every request, the page shell and sign-in included, died with
FUNCTION_INVOCATION_FAILED. The process must start, serve the shell, and say
exactly what is missing on the readiness probe."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

PROBE = r"""
import json
from fastapi.testclient import TestClient
from backend.infra.store.shared import StoreUnavailable
from backend.infra.store.store import get_store
from backend.main import app

client = TestClient(app)
out = {
    "live": client.get("/api/health").status_code,
    "ready": client.get("/api/health/ready").status_code,
    "ready_body": client.get("/api/health/ready").json(),
    "store": type(get_store()).__name__,
}
try:
    get_store().get_document("users", "u1")
    out["store_call"] = "returned"
except StoreUnavailable as exc:
    out["store_call"] = str(exc)
print("RESULT" + json.dumps(out))
"""


def test_app_starts_and_reports_missing_storage_setting() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPABASE_", "MINDPAL_STORAGE"))}
    env.update({"MINDPAL_STORAGE_PROVIDER": "supabase", "ENABLE_FIREBASE": "false", "PYTHONPATH": str(ROOT)})
    proc = subprocess.run([sys.executable, "-c", PROBE], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT")), None)
    assert line, proc.stderr[-2000:]
    out = json.loads(line[len("RESULT"):])

    assert out["live"] == 200
    assert out["ready"] == 503
    storage = out["ready_body"]["detail"]["storage"]
    assert storage["status"] == "misconfigured" and "SUPABASE_URL" in storage["reason"]
    assert out["store"] == "UnavailableStore"
    assert "SUPABASE_URL" in out["store_call"]


def test_production_never_runs_on_memory_storage() -> None:
    """Audit MP-16: production could start on per-process memory and report ready."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPABASE_", "MINDPAL_STORAGE"))}
    env.update({
        "ENVIRONMENT": "production",
        "MINDPAL_STORAGE_PROVIDER": "memory",
        "ENABLE_FIREBASE": "false",
        "PYTHONPATH": str(ROOT),
    })
    proc = subprocess.run([sys.executable, "-c", PROBE], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT")), None)
    assert line, proc.stderr[-2000:]
    out = json.loads(line[len("RESULT"):])
    assert out["live"] == 200
    assert out["ready"] == 503
    assert out["store"] == "UnavailableStore"
    assert "durable storage" in out["ready_body"]["detail"]["storage"]["reason"]
