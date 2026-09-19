# tests/conftest.py — platform rebuild. Legacy suite is paused until pal-7.

from __future__ import annotations

import os
from collections.abc import Generator

os.environ["ENVIRONMENT"] = "test"

# The suite runs against the in-memory store, never a developer's (or CI's)
# Firestore project. Before this, whichever credentials happened to be in .env
# decided whether writes went to a real database, to a silent memory fallback,
# or nowhere — so the same test could pass on one machine and fail on the next
# for reasons that had nothing to do with the code under test.
os.environ["ENABLE_FIREBASE"] = "false"

# Credentials, so tests cannot spend real credits.
_CREDENTIAL_KEYS = (
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "MINDPAL_VOICE_LIVE",
    "MINDPAL_VOICE_LIVE_ALLOWLIST",
)

# Behaviour switches. `backend.main` loads .env / .env.local on import, so without
# this a developer's local provider routing silently changes what the suite is
# testing - which is how a green suite turns red after an unrelated config edit.
# Tests that care about a switch must set it themselves.
_BEHAVIOUR_KEYS = (
    "MINDPAL_VOICE_CLASSIFIER",
    "MINDPAL_LLM_PROVIDER",
    "MINDPAL_CHAT_PROVIDER",
    "MINDPAL_JSON_PROVIDER",
    "MINDPAL_LLM_FALLBACK",
    "GEMINI_MODEL",
    "GEMINI_JSON_MODEL",
    "OPENROUTER_MODEL",
    "OPENROUTER_JSON_MODEL",
    "OPENROUTER_BASE_URL",
    "GROQ_BASE_URL",
)

_ISOLATED_KEYS = _CREDENTIAL_KEYS + _BEHAVIOUR_KEYS

for _key in _ISOLATED_KEYS:
    os.environ.pop(_key, None)

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app


@pytest.fixture(scope="session", autouse=True)
def _isolate_llm_credentials() -> Generator[None, None, None]:
    """Unit tests must not call a live provider, spend credits, or inherit local routing."""
    saved = {key: os.environ.pop(key, None) for key in _ISOLATED_KEYS}
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


@pytest.fixture
def app():
    return create_app(serve_frontend=False)


@pytest.fixture
def client(app) -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client
