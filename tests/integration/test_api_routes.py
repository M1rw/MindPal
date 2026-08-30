# tests/integration/test_api_routes.py

import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.core.config import Settings


@pytest.fixture
def client():
    settings = Settings(
        ENVIRONMENT="test",
        OFFLINE_MODE=True,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=True,
    )
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data


def test_runtime_config_endpoint(client):
    response = client.get("/runtime-config.js")
    assert response.status_code == 200
    assert "window.MINDPAL_CONFIG" in response.text
