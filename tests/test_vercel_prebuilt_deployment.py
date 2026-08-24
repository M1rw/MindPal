import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATED_PREFIXES = (
    "frontend/css/tailwind.generated.css",
    "frontend/dist/",
    "frontend/voice/dist/",
    "frontend/voice/public/assets/",
    "frontend/voice/assets/",
    "frontend/voice/index.html",
    "frontend/prebuilt-assets.manifest.json",
)


def test_vercel_builds_and_verifies_frontend_in_deployment_workspace() -> None:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert config["framework"] == "fastapi"
    assert config["installCommand"].startswith("python -m pip install")
    assert (
        config["buildCommand"]
        == "npm ci && npm run build:vercel && python scripts/verify_frontend_build.py"
    )
    assert "outputDirectory" not in config


def test_build_verifier_does_not_require_a_committed_manifest() -> None:
    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout.decode().split("\0")
    generated = [
        path
        for path in tracked
        if path and path.startswith(GENERATED_PREFIXES)
    ]
    assert generated == []


def test_build_verifier_accepts_current_generated_workspace() -> None:
    completed = subprocess.run(
        [sys.executable, "scripts/verify_frontend_build.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Frontend build verified" in completed.stdout
