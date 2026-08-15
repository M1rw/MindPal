from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

favicon_router = importlib.import_module("backend.api.favicon_router")
from backend.api.dependencies import get_services
from backend.core.config import Settings
from backend.main import create_app


app = create_app(
    Settings(
        _env_file=None,
        ENVIRONMENT="test",
        ENABLE_FIREBASE=False,
        TRUSTED_HOSTS=["testserver", "mindpal-demo.vercel.app"],
    )
)


async def _get_runtime_config_body(app, *, base_url: str = "http://testserver") -> str:
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=base_url) as client:
        response = await client.get(
            "/runtime-config.js",
            headers={"host": "mindpal-demo.vercel.app"},
        )
    return response.text


def test_frontend_root_references_production_bundles() -> None:
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "./dist/app.bundle.js" in response.text
    assert "./dist/lucide.bundle.js" in response.text
    assert "cdn.tailwindcss.com" not in response.text
    assert "unpkg.com" not in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    csp = response.headers["content-security-policy"]
    assert "script-src 'self';" in csp
    assert "script-src 'self' blob:" not in csp
    assert "img-src 'self' data: blob: https://*.googleusercontent.com;" in csp
    assert "https://www.google.com" not in csp
    assert "https://*.gstatic.com" not in csp


def test_favicon_proxy_returns_a_same_origin_safe_image(monkeypatch) -> None:
    favicon_router._cache.clear()

    async def fake_fetch(_target_url, _client):
        return b"\x89PNG\r\n\x1a\nsite-icon", "image/png"

    monkeypatch.setattr(favicon_router, "_fetch_favicon", fake_fetch)
    app.dependency_overrides[get_services] = lambda: SimpleNamespace(http_client=None)
    try:
        with TestClient(app) as client:
            response = client.get("/api/favicon", params={"url": "https://www.nhs.uk/mental-health/"})
            invalid = client.get("/api/favicon", params={"url": "http://127.0.0.1/favicon.ico"})
    finally:
        app.dependency_overrides.pop(get_services, None)

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")
    assert "max-age=86400" in response.headers["cache-control"]
    assert invalid.status_code == 400


def test_runtime_config_and_bundles_are_served() -> None:
    with TestClient(app) as client:
        runtime = client.get("/runtime-config.js")
        app_bundle = client.get("/dist/app.bundle.js")
        icon_bundle = client.get("/dist/lucide.bundle.js")
        css_bundle = client.get("/css/tailwind.generated.css")
        capture_worklet = client.get("/js/voice/pcm_capture_worklet.js")

    assert runtime.status_code == 200
    assert runtime.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    assert "GEMINI_API_KEY" not in runtime.text
    assert app_bundle.status_code == 200 and len(app_bundle.content) > 100_000
    assert icon_bundle.status_code == 200 and len(icon_bundle.content) > 5_000
    assert css_bundle.status_code == 200 and len(css_bundle.content) > 10_000
    assert capture_worklet.status_code == 200
    assert "registerProcessor" in capture_worklet.text


def test_runtime_config_is_generated_from_deployment_settings_without_server_secrets() -> None:
    configured_app = create_app(
        Settings(
            _env_file=None,
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
    assert '"FIREBASE_ENABLED":false' in response.text
    assert "server-provider-secret" not in response.text
    assert "FIREBASE_CREDENTIALS_JSON" not in response.text


def test_runtime_config_derives_firebase_hosting_domain_when_auth_domain_is_omitted() -> None:
    configured_app = create_app(
        Settings(
            _env_file=None,
            ENVIRONMENT="test",
            ENABLE_FIREBASE=True,
            FIREBASE_USE_APPLICATION_DEFAULT=True,
            FIREBASE_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_API_KEY="public-web-key",
            FIREBASE_AUTH_DOMAIN="",
            FIREBASE_WEB_APP_ID="1:123:web:mindpal",
            FIREBASE_APPCHECK_SITE_KEY="public-app-check-site-key",
        )
    )

    import asyncio

    response_text = asyncio.run(
        _get_runtime_config_body(configured_app, base_url="https://mindpal-demo.vercel.app")
    )

    assert '"authDomain":"mindpal-production.firebaseapp.com"' in response_text
    assert '"FIREBASE_ENABLED":true' in response_text


def test_csp_permits_same_origin_firebase_auth_helper_iframe() -> None:
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    policy = response.headers["content-security-policy"]
    assert "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com" in policy


def test_safe_mode_runtime_debugger_route_and_assets_are_delivered() -> None:
    with TestClient(app) as client:
        root = client.get("/")
        brain_page = client.get("/brain")
        brain_css = client.get("/css/brain.css")
        brain_bundle = client.get("/dist/brain.bundle.js")
        chat_bundle = client.get("/dist/app.bundle.js")

    assert root.status_code == 200
    assert 'id="brain-btn"' not in root.text
    assert 'id="brain-workspace"' not in root.text
    assert brain_page.status_code == 200
    assert 'id="safe-graph-svg"' in brain_page.text
    assert 'id="safe-terminal-lines"' in brain_page.text
    assert "MINDPAL CORE" in brain_page.text
    assert "runtime-config.js" not in brain_page.text
    assert brain_css.status_code == 200
    assert ".safe-mode" in brain_css.text
    assert "prefers-reduced-motion" in brain_css.text
    assert brain_bundle.status_code == 200 and len(brain_bundle.content) > 5_000
    assert "mindpal_safe_mode_last_trace_v1" in brain_bundle.text
    assert "firebase" not in brain_bundle.text.lower()
    assert chat_bundle.status_code == 200
    assert "mindpal_safe_mode_trace" in chat_bundle.text


def test_frontend_does_not_ship_user_visible_thought_duration() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    status_source = (root / "frontend/js/ui_state.js").read_text(encoding="utf-8")
    bundle = (root / "frontend/dist/app.bundle.js").read_text(encoding="utf-8")

    assert "Thought for ${seconds}s" not in status_source
    assert "Thought for" not in bundle
    assert "removeStatusIndicator(id)" in status_source


def test_firebase_popup_internal_error_uses_redirect_handoff() -> None:
    root = Path(__file__).resolve().parents[1]
    auth_source = (root / "frontend" / "js" / "auth.js").read_text(encoding="utf-8")
    app_source = (root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "signInWithRedirect" in auth_source
    assert "getRedirectResult" in auth_source
    assert "const redirectResult = await getRedirectResult(firebaseAuth)" in auth_source
    assert 'code.includes("internal-error")' in auth_source
    assert "await signInWithRedirect(auth, provider)" in auth_source
    assert "const credential = await signInWithPopup(auth, provider)" in auth_source
    assert 'await startRedirectSignIn(auth, provider, "Google")' in auth_source
    assert "REDIRECT_PENDING_KEY" in auth_source
    assert "getAuthRedirectDiagnostic" in auth_source
    assert "account-auth-diagnostic" in app_source
    assert "Continue in the provider window" in app_source
    assert "redirectHandoff = true" in app_source


def test_cloud_login_modal_exposes_web_supported_firebase_methods() -> None:
    root = Path(__file__).resolve().parents[1]
    index_source = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    auth_source = (root / "frontend" / "js" / "auth.js").read_text(encoding="utf-8")
    app_source = (root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'id="auth-modal"' in index_source
    assert 'id="auth-google-btn"' in index_source
    assert 'id="auth-apple-btn"' in index_source
    assert 'id="auth-phone-btn"' in index_source
    assert 'id="auth-email-form"' in index_source
    assert 'id="auth-phone-recaptcha"' in index_source
    assert 'id="account-auth-diagnostic"' in index_source
    assert "signInWithEmailAndPassword" in auth_source
    assert "createUserWithEmailAndPassword" in auth_source
    assert "sendPasswordResetEmail" in auth_source
    assert 'new OAuthProvider("apple.com")' in auth_source
    assert "new RecaptchaVerifier" in auth_source
    assert "signInWithPhoneNumber" in auth_source
    assert "bindAuthModal();" in app_source
    assert "completeCloudConnection" in app_source
    assert "confirmPhoneNumberSignIn" in app_source


def test_vercel_uses_firebase_hosted_popup_auth_without_custom_proxy() -> None:
    root = Path(__file__).resolve().parents[1]
    deployment = json.loads((root / "vercel.json").read_text(encoding="utf-8"))

    assert deployment["env"]["FIREBASE_USE_SAME_ORIGIN_AUTH_PROXY"] == "false"
    assert not any(
        item.get("source") == "/__/auth/(.*)"
        for item in deployment.get("rewrites", [])
    )
    assert not any(item.get("src") == "/__/auth/(.*)" for item in deployment.get("routes", []))


def test_runtime_config_uses_same_origin_auth_domain_only_with_firebase_proxy() -> None:
    proxied_app = create_app(
        Settings(
            _env_file=None,
            ENVIRONMENT="test",
            ENABLE_FIREBASE=True,
            FIREBASE_USE_APPLICATION_DEFAULT=True,
            FIREBASE_WEB_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_API_KEY="public-web-key",
            FIREBASE_WEB_APP_ID="1:123:web:mindpal",
            FIREBASE_USE_SAME_ORIGIN_AUTH_PROXY=True,
        )
    )

    import asyncio

    response_text = asyncio.run(
        _get_runtime_config_body(proxied_app, base_url="https://mindpal-demo.vercel.app")
    )

    assert '"authDomain":"mindpal-demo.vercel.app"' in response_text
    assert '"FIREBASE_ENABLED":true' in response_text
