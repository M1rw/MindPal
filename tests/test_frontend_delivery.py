from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from backend.api.dependencies import get_services
from backend.core.config import Settings
from backend.main import create_app

favicon_router = importlib.import_module("backend.api.favicon_router")


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
    assert "script-src 'self' https://accounts.google.com;" in csp
    assert "script-src 'self' blob:" not in csp
    assert "connect-src 'self' https://accounts.google.com" in csp
    assert "img-src 'self' data: blob: https://*.googleusercontent.com;" in csp
    assert "https://www.google.com" not in csp
    assert "https://*.gstatic.com" not in csp


def test_voice_overlay_uses_compact_standalone_safe_area_controls() -> None:
    root = Path(__file__).resolve().parents[1]
    html = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    css = (root / "frontend" / "css" / "style.css").read_text(encoding="utf-8")

    assert "voice-live-controls" in html
    assert "pb-[max(env(safe-area-inset-bottom,24px),24px)]" not in html
    assert ".voice-live-controls" in css
    assert "padding-bottom: max(env(safe-area-inset-bottom, 0px), 0.5rem);" in css
    assert "@media all and (display-mode: standalone)" in css
    assert "padding-bottom: max(env(safe-area-inset-bottom, 0px), 0.375rem);" in css


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
    assert capture_worklet.status_code == 404


def test_runtime_config_disables_firebase_when_server_provider_unconfigured() -> None:
    unconfigured_app = create_app(
        Settings(
            _env_file=None,
            ENVIRONMENT="test",
            ENABLE_FIREBASE=True,
            FIREBASE_PROJECT_ID="mindpal-production",
            FIREBASE_CREDENTIALS_JSON='{"project_id": "mismatched-project", "private_key": "x"}',
            FIREBASE_WEB_PROJECT_ID="mindpal-production",
            FIREBASE_WEB_API_KEY="public-web-key",
            FIREBASE_AUTH_DOMAIN="mindpal-production.firebaseapp.com",
            FIREBASE_WEB_APP_ID="1:123:web:mindpal",
        )
    )
    with TestClient(unconfigured_app) as client:
        response = client.get("/runtime-config.js")

    assert response.status_code == 200
    assert '"FIREBASE_ENABLED":false' in response.text
    assert '"FIREBASE_CONFIG":{' in response.text


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


def test_runtime_config_enables_voice_release_only_on_matching_approved_deployment() -> None:
    preview_app = create_app(
        Settings(
            _env_file=None,
            ENVIRONMENT="production",
            VERCEL_ENV="preview",
            VOICE_V4_PREVIEW_ENVIRONMENT="staging",
            VOICE_V4_PREVIEW_APPROVED=True,
            VOICE_V4_PREVIEW_SESSION_ENABLED=True,
            ENABLE_HSTS=True,
            TRUSTED_HOSTS=["testserver"],
            ENABLE_FIREBASE=False,
        )
    )
    with TestClient(preview_app) as client:
        preview_response = client.get("/runtime-config.js")

    assert '"ENVIRONMENT":"staging"' in preview_response.text
    assert '"VOICE_V4_PREVIEW_APPROVED":true' in preview_response.text
    assert '"VOICE_V4_PREVIEW_SESSION_ENABLED":true' in preview_response.text

    production_app = create_app(
        Settings(
            _env_file=None,
            ENVIRONMENT="production",
            VERCEL_ENV="production",
            VOICE_V4_PREVIEW_ENVIRONMENT="production",
            VOICE_V4_PREVIEW_APPROVED=True,
            VOICE_V4_PREVIEW_SESSION_ENABLED=True,
            ENABLE_HSTS=True,
            TRUSTED_HOSTS=["testserver"],
            ENABLE_FIREBASE=False,
        )
    )
    with TestClient(production_app) as client:
        production_response = client.get("/runtime-config.js")

    assert '"ENVIRONMENT":"production"' in production_response.text
    assert '"VOICE_V4_PREVIEW_APPROVED":true' in production_response.text
    assert '"VOICE_V4_PREVIEW_SESSION_ENABLED":true' in production_response.text


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


def test_privacy_and_terms_pages_are_publicly_delivered_and_linked() -> None:
    root = Path(__file__).resolve().parents[1]
    with TestClient(app) as client:
        privacy_page = client.get("/privacy")
        terms_page = client.get("/terms")
        legal_css = client.get("/css/legal.css")

    sitemap = (root / "frontend" / "sitemap.xml").read_text(encoding="utf-8")
    index_source = (root / "frontend" / "index.html").read_text(encoding="utf-8")

    assert privacy_page.status_code == 200
    assert "Privacy Policy — MindPal" in privacy_page.text
    assert "Local Mode" in privacy_page.text
    assert 'href="/terms"' in privacy_page.text
    assert terms_page.status_code == 200
    assert "Terms of Service — MindPal" in terms_page.text
    assert "Safety and health boundaries" in terms_page.text
    assert 'href="/privacy"' in terms_page.text
    assert legal_css.status_code == 200
    assert ".legal-document" in legal_css.text
    assert "prefers-reduced-motion" in legal_css.text
    assert "https://mindpal-demo.vercel.app/privacy" in sitemap
    assert "https://mindpal-demo.vercel.app/terms" in sitemap
    assert 'href="/privacy"' in index_source
    assert 'href="/terms"' in index_source


def test_frontend_does_not_ship_user_visible_thought_duration() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    status_source = (root / "frontend/js/state/ui_state.js").read_text(encoding="utf-8")
    bundle = (root / "frontend/dist/app.bundle.js").read_text(encoding="utf-8")

    assert "Thought for ${seconds}s" not in status_source
    assert "Thought for" not in bundle
    assert "removeStatusIndicator(id)" in status_source


def test_firebase_google_identity_auth_recovers_from_stale_redirect_errors() -> None:
    root = Path(__file__).resolve().parents[1]
    auth_source = (root / "frontend" / "js" / "services" / "auth.js").read_text(encoding="utf-8")
    app_source = (root / "frontend" / "js" / "app" / "main.js").read_text(encoding="utf-8")

    assert "getRedirectResult" in auth_source
    assert "const redirectResult = await getRedirectResult(firebaseAuth)" in auth_source
    assert "function requireInitializedPopupAuth()" in auth_source
    assert "preloadGoogleIdentityServices" in auth_source
    assert "window.google.accounts.oauth2.initTokenClient" in auth_source
    assert "GoogleAuthProvider.credential(null, response.access_token)" in auth_source
    assert "signInWithCredential(auth, firebaseCredential)" in auth_source
    assert "Google Identity Services" in auth_source
    assert "signInWithRedirect" not in auth_source
    assert "clearPendingRedirect();" in auth_source
    assert "never prevent auth initialization or state listeners from completing" in auth_source
    assert "REDIRECT_PENDING_KEY" in auth_source
    assert "getAuthRedirectDiagnostic" in auth_source
    assert "getSafeFirebaseFailureDetail" in auth_source
    assert 'stage: "browser_persistence"' in auth_source
    assert '"google_credential_exchange",' in auth_source
    assert '`${providerName.toLowerCase()}_popup`,' in auth_source
    assert "Firebase reason:" in app_source
    assert "account-auth-diagnostic" in app_source
    assert "Firebase did not return a signed-in user." in app_source
    assert "redirectHandoff = true" not in app_source


def test_cloud_login_modal_exposes_web_supported_firebase_methods() -> None:
    root = Path(__file__).resolve().parents[1]
    index_source = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    auth_source = (root / "frontend" / "js" / "services" / "auth.js").read_text(encoding="utf-8")
    app_source = (root / "frontend" / "js" / "app" / "main.js").read_text(encoding="utf-8")

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
            FIREBASE_PROJECT_ID="mindpal-production",
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


def test_voice_overlay_uses_a_connection_only_spinner_accessibly() -> None:
    root = Path(__file__).resolve().parents[1]
    html = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    css = (root / "frontend" / "css" / "style.css").read_text(encoding="utf-8")

    assert 'id="voice-startup-spinner"' in html
    assert 'id="voice-holo-loader"' not in html
    assert 'id="voice-live-status" aria-live="polite"' in html
    assert ".voice-startup-spinner" in css
    assert 'data-voice-phase="connecting"' in css
    assert 'data-voice-phase="attending"' not in css
    assert "@media (prefers-reduced-motion: reduce)" in css
