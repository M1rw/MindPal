from __future__ import annotations

from fastapi.testclient import TestClient

from backend.core.config import Settings
from backend.main import app, create_app


def test_frontend_root_references_production_bundles() -> None:
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "./dist/app.bundle.js" in response.text
    assert "./dist/lucide.bundle.js" in response.text
    assert "cdn.tailwindcss.com" not in response.text
    assert "unpkg.com" not in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "script-src 'self'" in response.headers["content-security-policy"]


def test_runtime_config_and_bundles_are_served() -> None:
    with TestClient(app) as client:
        runtime = client.get("/runtime-config.js")
        app_bundle = client.get("/dist/app.bundle.js")
        icon_bundle = client.get("/dist/lucide.bundle.js")
        css_bundle = client.get("/css/tailwind.generated.css")

    assert runtime.status_code == 200
    assert runtime.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    assert "GEMINI_API_KEY" not in runtime.text
    assert app_bundle.status_code == 200 and len(app_bundle.content) > 100_000
    assert icon_bundle.status_code == 200 and len(icon_bundle.content) > 5_000
    assert css_bundle.status_code == 200 and len(css_bundle.content) > 10_000


def test_runtime_config_is_generated_from_deployment_settings_without_server_secrets() -> None:
    configured_app = create_app(
        Settings(
            ENVIRONMENT="test",
            ENABLE_FIREBASE=False,
            PUBLIC_API_BASE_URL="https://api.mindpal.example/api",
            FIREBASE_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_API_KEY="public-web-key",
            FIREBASE_AUTH_DOMAIN="mindpal-production.firebaseapp.com",
            FIREBASE_WEB_APP_ID="1:123:web:mindpal",
            FIREBASE_APPCHECK_SITE_KEY="public-app-check-site-key",
            GEMINI_API_KEY="server-provider-secret",
        )
    )
    with TestClient(configured_app) as client:
        response = client.get("/runtime-config.js")

    assert response.status_code == 200
    assert '"API_BASE_URL":"https://api.mindpal.example/api"' in response.text
    assert '"projectId":"mindpal-production"' in response.text
    assert '"FIREBASE_APPCHECK_SITE_KEY":"public-app-check-site-key"' in response.text
    assert "server-provider-secret" not in response.text
    assert "FIREBASE_CREDENTIALS_JSON" not in response.text
