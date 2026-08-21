from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_vercel_rebuilds_and_verifies_frontend() -> None:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert config["framework"] == "fastapi"
    assert config["installCommand"].startswith("python -m pip install")
    assert (
        config["buildCommand"]
        == "npm ci && npm run build && npm run build:voice-v3-auth && mkdir -p voice-v3/public && cp frontend/dist/voice-v3-auth.bundle.js voice-v3/public/voice-v3-auth.bundle.js && npm --prefix voice-v3 ci && npm --prefix voice-v3 run build && rm -rf frontend/voice-v3 && mkdir -p frontend/voice-v3 && cp -R voice-v3/dist/. frontend/voice-v3/ && python scripts/verify_prebuilt_frontend.py"
    )
    assert "outputDirectory" not in config


def test_prebuilt_frontend_manifest_is_current() -> None:
    completed = subprocess.run(
        [sys.executable, "scripts/verify_prebuilt_frontend.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Prebuilt frontend verified" in completed.stdout
