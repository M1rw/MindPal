# tests/backend/api/test_deployment_config.py - every deployment setting is actually read
"""Audit MP-23: vercel.json set TRUSTED_HOSTS and CORS_ORIGINS while the app
reads MINDPAL_ALLOWED_HOSTS and MINDPAL_CORS_ORIGINS, plus a dozen keys left
over from removed features (LLM_PROVIDER_ORDER, SAFETY_ENABLED, CAMB_*...).
Setting any of them changed nothing. A key must be a Settings alias or be
referenced by name in backend code."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.configs.settings import Settings

ROOT = Path(__file__).resolve().parents[3]
# Read by the platform or runtime, not by application code.
PLATFORM_KEYS = {"PYTHONUNBUFFERED"}


def _read_names() -> set[str]:
    names: set[str] = set()
    for field in Settings.model_fields.values():
        alias = field.validation_alias
        if isinstance(alias, str):
            names.add(alias)
        elif alias is not None:
            names.update(str(choice) for choice in getattr(alias, "choices", []))
    sources = list((ROOT / "backend").rglob("*.py")) + list((ROOT / "scripts").rglob("*.py")) + [ROOT / "api" / "index.py"]
    text = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in sources)
    names.update(re.findall(r"['\"]([A-Z][A-Z0-9_]{2,})['\"]", text))
    return names


READ = _read_names()


def _env_example_keys() -> list[str]:
    keys = []
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        match = re.match(r"^#?\s*([A-Z][A-Z0-9_]+)=", line)
        if match:
            keys.append(match.group(1))
    return keys


@pytest.mark.parametrize("key", sorted(json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))["env"]))
def test_vercel_env_keys_are_read(key: str) -> None:
    assert key in READ or key in PLATFORM_KEYS, f"vercel.json sets {key}, which nothing reads"


@pytest.mark.parametrize("key", sorted(set(_env_example_keys())))
def test_env_example_keys_are_read(key: str) -> None:
    assert key in READ or key in PLATFORM_KEYS, f".env.example documents {key}, which nothing reads"


def test_cors_allows_the_idempotency_header_for_configured_origins(monkeypatch) -> None:
    monkeypatch.setenv("MINDPAL_CORS_ORIGINS", "https://app.example.com")
    from backend.main import create_app

    client = TestClient(create_app(serve_frontend=False))
    response = client.options(
        "/api/chat/stream",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
    )
    assert response.status_code == 200
    assert "idempotency-key" in response.headers.get("access-control-allow-headers", "").lower()


def test_every_npm_script_points_at_a_real_file() -> None:
    """Audit MP-27: three scripts ran files that no longer exist."""
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    for name, command in scripts.items():
        for path in re.findall(r"(?:scripts|tests|frontend)/[\w./*-]+\.(?:py|mjs|js|tsx|ts|css)", command):
            if "*" in path:
                assert list(ROOT.glob(path)), f"npm run {name}: nothing matches {path}"
            elif not path.startswith("frontend/dist/") and not path.endswith("tailwind.generated.css"):
                assert (ROOT / path).exists(), f"npm run {name}: {path} does not exist"


@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_validation_runs_for_deployment_only_changes(event: str) -> None:
    """Audit MP-27: a PR touching only vercel.json or api/ skipped every check."""
    workflow = (ROOT / ".github" / "workflows" / "validation.yml").read_text(encoding="utf-8")
    triggers = workflow.split("\njobs:", 1)[0]
    push, pull_request = triggers.split("\n  pull_request:", 1)
    paths = push if event == "push" else pull_request
    for required in ("'api/**'", "'vercel.json'", "'.vercelignore'", "'data/**'"):
        assert required in paths, f"{event} trigger misses {required}"
