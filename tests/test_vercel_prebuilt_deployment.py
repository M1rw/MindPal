from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_vercel_never_compiles_frontend() -> None:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert config["framework"] == "fastapi"
    assert config["installCommand"].startswith("python -m pip install")
    assert config["buildCommand"] == "python scripts/verify_prebuilt_frontend.py"
    combined = f"{config['installCommand']} {config['buildCommand']}".lower()
    assert "npm" not in combined
    assert "tailwind" not in combined
    assert "esbuild" not in combined
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
