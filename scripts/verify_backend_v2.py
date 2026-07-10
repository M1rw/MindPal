#!/usr/bin/env python3
"""MindPal Backend V2 deterministic release verification.

Runs local, reproducible gates. Network-dependent Python CVE lookup is optional
because release verification must remain usable in restricted CI environments.
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@dataclass(frozen=True)
class Gate:
    name: str
    command: Sequence[str]
    cwd: Path = ROOT
    optional: bool = False


def run_command(gate: Gate) -> None:
    print(f"\n==> {gate.name}", flush=True)
    print("$", " ".join(gate.command), flush=True)
    completed = subprocess.run(
        list(gate.command),
        cwd=gate.cwd,
        env=os.environ.copy(),
        check=False,
    )
    if completed.returncode != 0:
        if gate.optional:
            print(f"WARN: optional gate failed: {gate.name}", file=sys.stderr)
            return
        raise SystemExit(f"FAILED: {gate.name} (exit {completed.returncode})")


def first_available(*commands: Sequence[str]) -> Sequence[str]:
    for command in commands:
        if command and shutil.which(command[0]):
            return command
    raise SystemExit(f"No executable available for: {commands!r}")


def require_files(paths: Iterable[Path]) -> None:
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    if missing:
        raise SystemExit("Missing required release files: " + ", ".join(missing))


def assert_static_invariants() -> None:
    print("\n==> Static architecture invariants")

    backend_files = list((ROOT / "backend").rglob("*.py"))
    violations: list[str] = []
    for path in backend_files:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if isinstance(node.func.value, ast.Name) and node.func.value.id == "os" and node.func.attr == "getenv":
                    violations.append(f"{path.relative_to(ROOT)} calls os.getenv at line {node.lineno}")
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute):
                if isinstance(node.value.value, ast.Name) and node.value.value.id == "os" and node.value.attr == "environ":
                    violations.append(f"{path.relative_to(ROOT)} reads os.environ directly at line {node.lineno}")
        if "quick_llm_generate" in text:
            violations.append(f"{path.relative_to(ROOT)} references retired quick_llm_generate")

    voice_router = (ROOT / "backend/api/voice_router.py").read_text(encoding="utf-8")
    if '@router.get("/key", status_code=status.HTTP_410_GONE)' not in voice_router:
        violations.append("legacy /api/voice/key route is not explicitly retired with HTTP 410")
    retired_start = voice_router.find("async def retired_voice_key_endpoint")
    retired_end = voice_router.find("async def _create_ephemeral_voice_token", retired_start)
    retired_body = voice_router[retired_start:retired_end]
    if "GEMINI_API_KEY" in retired_body or '"key"' in retired_body:
        violations.append("retired /api/voice/key endpoint may disclose a provider key")

    runtime_config = (ROOT / "frontend/runtime-config.js").read_text(encoding="utf-8").lower()
    for secret_name in ("gemini_api_key", "openrouter_api_key", "groq_api_key", "private_key"):
        if secret_name in runtime_config:
            violations.append(f"frontend runtime config contains provider/server secret field: {secret_name}")

    config_text = (ROOT / "backend/core/config.py").read_text(encoding="utf-8")
    if 'raise ValueError("Wildcard CORS is not allowed in production")' not in config_text:
        violations.append("production wildcard-CORS rejection is missing")
    if "REQUIRE_FIREBASE_APP_CHECK" not in config_text:
        violations.append("Firebase App Check production requirement is missing")

    if violations:
        raise SystemExit("Static invariant failures:\n- " + "\n- ".join(violations))
    print("Static invariants passed")


def smoke_production_configuration() -> None:
    print("\n==> Production configuration and OpenAPI smoke test")
    from backend.core.config import Settings
    from backend.main import create_app

    project_id = "mindpal-release-smoke"
    credentials = {
        "type": "service_account",
        "project_id": project_id,
        "private_key_id": "release-smoke",
        "private_key": "release-smoke-placeholder",
        "client_email": f"release-smoke@{project_id}.iam.gserviceaccount.com",
        "client_id": "100000000000000000001",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/release-smoke",
    }

    settings = Settings(
        _env_file=None,
        ENVIRONMENT="production",
        ENABLE_DOCS=False,
        ENABLE_HSTS=True,
        TRUSTED_HOSTS=["mindpal.example.com"],
        CORS_ORIGINS=["https://mindpal.example.com"],
        ENABLE_FIREBASE=True,
        FIREBASE_CREDENTIALS_JSON=json.dumps(credentials),
        FIREBASE_PROJECT_ID=project_id,
        FIREBASE_CHECK_REVOKED_TOKENS=True,
        REQUIRE_FIREBASE_APP_CHECK=True,
        FIREBASE_APPCHECK_SITE_KEY="release-smoke-site-key",
        FIREBASE_WEB_API_KEY="release-smoke-web-key",
        FIREBASE_AUTH_DOMAIN=f"{project_id}.firebaseapp.com",
        FIREBASE_WEB_PROJECT_ID=project_id,
        FIREBASE_WEB_APP_ID="1:100000000000:web:release-smoke",
        GEMINI_API_KEY="release-smoke-provider-key",
        REQUIRE_REMOTE_LLM_PROVIDER=True,
        ENABLE_OFFLINE_LLM_FALLBACK=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=False,
        ALLOW_ANONYMOUS_SESSIONS=False,
        REQUIRE_AUTH_FOR_PROVIDER_CALLS=True,
    )
    app = create_app(settings)
    schema = app.openapi()
    paths = schema.get("paths", {})
    required_paths = {
        "/api/chat",
        "/api/chat/stream",
        "/api/voice/token",
        "/api/memory/v3",
        "/api/tools/execute",
    }
    missing = sorted(required_paths - set(paths))
    if missing:
        raise SystemExit(f"OpenAPI smoke test missing routes: {missing}")
    if app.docs_url is not None or app.redoc_url is not None or app.openapi_url is not None:
        raise SystemExit("Production API documentation endpoints are unexpectedly enabled")
    print(f"Production configuration passed; OpenAPI resolved {len(paths)} routes")


def verify_outputs() -> None:
    print("\n==> Frontend output checks")
    outputs = {
        ROOT / "frontend/css/tailwind.generated.css": 10_000,
        ROOT / "frontend/dist/lucide.bundle.js": 5_000,
        ROOT / "frontend/dist/app.bundle.js": 100_000,
    }
    for path, minimum_size in outputs.items():
        if not path.is_file():
            raise SystemExit(f"Missing frontend build output: {path.relative_to(ROOT)}")
        size = path.stat().st_size
        if size < minimum_size:
            raise SystemExit(
                f"Frontend output is unexpectedly small: {path.relative_to(ROOT)} ({size} bytes)"
            )
        print(f"{path.relative_to(ROOT)}: {size:,} bytes")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--online-audit",
        action="store_true",
        help="Also run pip-audit against requirements.lock (requires package-index access).",
    )
    args = parser.parse_args()

    os.chdir(ROOT)
    require_files(
        [
            ROOT / "requirements.lock",
            ROOT / "requirements-dev.lock",
            ROOT / "package-lock.json",
            ROOT / ".env.production.example",
            ROOT / "BACKEND_V2_ARCHITECTURE.md",
            ROOT / "DEPLOY_BACKEND_V2.md",
        ]
    )

    ruff_args = ("check", "backend", "api", "tests", "scripts/verify_backend_v2.py")
    if importlib.util.find_spec("ruff") is not None:
        ruff_command = (sys.executable, "-m", "ruff", *ruff_args)
    elif shutil.which("ruff"):
        ruff_command = ("ruff", *ruff_args)
    elif shutil.which("uvx"):
        ruff_command = ("uvx", "ruff", *ruff_args)
    else:
        raise SystemExit("Ruff is not installed and uvx is unavailable")
    bandit_command = first_available(
        (sys.executable, "-m", "bandit", "-q", "-r", "backend", "api"),
        ("bandit", "-q", "-r", "backend", "api"),
    )

    gates = [
        Gate("Python bytecode compilation", (sys.executable, "-m", "compileall", "-q", "backend", "api", "tests")),
        Gate("Python test suite", (sys.executable, "-m", "pytest", "-q")),
        Gate("JavaScript regression suite", ("npm", "test", "--", "--test-reporter=spec")),
        Gate("Ruff static analysis", ruff_command),
        Gate("Bandit security analysis", bandit_command),
        Gate("Production frontend build", ("npm", "run", "build")),
        Gate("Frontend security/delivery audit", (sys.executable, "scripts/audit_frontend.py")),
        Gate("npm production dependency audit", ("npm", "audit", "--omit=dev", "--audit-level=high")),
    ]

    for gate in gates:
        run_command(gate)

    assert_static_invariants()
    smoke_production_configuration()
    verify_outputs()

    if args.online_audit:
        pip_audit = first_available(
            (sys.executable, "-m", "pip_audit", "-r", "requirements.lock"),
            ("pip-audit", "-r", "requirements.lock"),
        )
        run_command(Gate("Python dependency CVE audit", pip_audit))

    print("\nMindPal Backend V2 verification PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
