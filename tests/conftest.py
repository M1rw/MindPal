# tests/conftest.py

from __future__ import annotations

from typing import Generator
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from backend.core.config import Settings
from backend.main import create_app
from backend.services.bootstrap import build_service_container


TEST_USER_HASH = "test_user_hash_12345"
TEST_ADMIN_USER_HASH = "test_admin_hash_99999"


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        ENVIRONMENT="test",
        LOG_LEVEL="DEBUG",
        ENABLE_METRICS=False,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=True,
        ENABLE_OFFLINE_LLM_FALLBACK=True,
        REQUIRE_AUTH_FOR_PROVIDER_CALLS=False,
        ALLOW_ANONYMOUS_SESSIONS=True,
        VOICE_V4_PREVIEW_APPROVED=True,
        VOICE_V4_PREVIEW_SESSION_ENABLED=True,
        TRUSTED_HOSTS=["*"],
    )


@pytest_asyncio.fixture
async def service_container(test_settings: Settings):
    container = build_service_container(test_settings)
    await container.start()
    yield container
    await container.stop()


@pytest.fixture
def app(test_settings: Settings):
    return create_app(test_settings)


@pytest.fixture
def client(app) -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_client(app) -> Generator[TestClient, None, None]:
    headers = {
        "Authorization": "Bearer mock_test_token",
        "X-MindPal-User-ID": "test_user_123",
        "X-MindPal-Locale": "en",
        "X-MindPal-Channel": "web",
    }
    with TestClient(app, headers=headers) as test_client:
        yield test_client


@pytest_asyncio.fixture
async def async_client(app) -> AsyncClient:
    transport = ASGITransport(app=app)
    headers = {
        "Authorization": "Bearer mock_test_token",
        "X-MindPal-User-ID": "test_user_123",
        "X-MindPal-Locale": "en",
        "X-MindPal-Channel": "web",
    }
    async with AsyncClient(transport=transport, base_url="http://test", headers=headers) as ac:
        yield ac
