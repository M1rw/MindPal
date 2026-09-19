# backend/main.py

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.http.wire import wire_http

logger = logging.getLogger("mindpal.app")

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

# The API and the app are served from the same origin, so the browser needs no
# CORS grant at all by default. An explicit allowlist exists for split
# deployments; "*" is refused because these endpoints are cookie-free but
# Authorization-bearing, and a wildcard invites any page to drive them with a
# token it has phished.
CORS_ORIGINS_ENV = "MINDPAL_CORS_ORIGINS"
ALLOWED_HOSTS_ENV = "MINDPAL_ALLOWED_HOSTS"

# Matches what index.html actually loads. `unsafe-inline` on style-src reflects
# the inline styles already in the document.
#
# `blob:` on script-src is what AudioWorklet needs, and it is NOT covered by the
# worker-src blob: below. Chrome loads an `audioWorklet.addModule()` URL under
# script-src (falling back from script-src-elem), so with blob: missing there,
# both voice worklets were refused:
#
#   Loading the script 'blob:http://127.0.0.1:8765/...' violates the following
#   Content Security Policy directive: "script-src 'self' 'unsafe-inline' ..."
#
# The capture worklet's failure then surfaced to the caller as "The microphone
# could not be started", which is nowhere near the real cause. blob: adds no
# meaningful reach here: a blob URL is same-origin and script-src already
# carries 'unsafe-inline'.
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https://fonts.gstatic.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        # accounts.google.com serves the Google Sign-In client, which was also
        # being refused — and live voice needs a signed-in account.
        "script-src 'self' 'unsafe-inline' blob: https://www.gstatic.com https://apis.google.com https://accounts.google.com",
        "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "connect-src 'self' https: wss:",
        "upgrade-insecure-requests",
    )
)


def _load_env_files() -> None:
    """Load .env and .env.local without external dependencies for local runs."""
    for filename in (".env", ".env.local"):
        p = ROOT / filename
        if not p.exists():
            continue
        try:
            for raw_line in p.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except Exception:
            pass


_load_env_files()


def _csv_env(name: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


def configured_cors_origins() -> list[str]:
    """Explicit origins only. A wildcard is dropped with a warning, never honoured."""
    origins = []
    for origin in _csv_env(CORS_ORIGINS_ENV):
        if origin == "*":
            logger.error(
                "cors_wildcard_refused env=%s — list exact origins instead", CORS_ORIGINS_ENV
            )
            continue
        origins.append(origin)
    return origins


def _is_production() -> bool:
    return (os.environ.get("ENVIRONMENT") or "production").strip().lower() not in {
        "development",
        "dev",
        "test",
        "testing",
        "local",
    }


def create_app(*, serve_frontend: bool = True) -> FastAPI:
    app = FastAPI(title="MindPal", version="5.0.0", docs_url=None, redoc_url=None)

    allowed_hosts = _csv_env(ALLOWED_HOSTS_ENV)
    if allowed_hosts:
        # Blocks Host-header forgery, which otherwise poisons absolute URLs and
        # any cache in front of the app.
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    elif _is_production():
        logger.warning(
            "trusted_hosts_unset env=%s — set it to this deployment's hostnames", ALLOWED_HOSTS_ENV
        )

    origins = configured_cors_origins()
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-Id", "X-Firebase-AppCheck"],
            max_age=600,
        )

    @app.middleware("http")
    async def add_security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
        response.headers["Permissions-Policy"] = "geolocation=(), camera=(), payment=(), usb=()"
        if _is_production():
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    wire_http(app)

    if serve_frontend and FRONTEND.exists():
        _mount_frontend(app)
    return app


def _build_public_bootstrap_payload() -> dict[str, Any]:
    """Generates the non-secret client runtime bootstrap configuration."""
    api_key = os.environ.get("FIREBASE_WEB_API_KEY", "").strip() or os.environ.get("FIREBASE_API_KEY", "").strip()
    project_id = (
        os.environ.get("FIREBASE_WEB_PROJECT_ID", "").strip()
        or os.environ.get("FIREBASE_PROJECT_ID", "").strip()
        or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    )
    app_id = os.environ.get("FIREBASE_WEB_APP_ID", "").strip() or os.environ.get("FIREBASE_APP_ID", "").strip()
    auth_domain = os.environ.get("FIREBASE_AUTH_DOMAIN", "").strip() or (f"{project_id}.firebaseapp.com" if project_id else "")
    storage_bucket = os.environ.get("FIREBASE_STORAGE_BUCKET", "").strip() or (f"{project_id}.appspot.com" if project_id else "")
    messaging_sender_id = os.environ.get("FIREBASE_MESSAGING_SENDER_ID", "").strip()
    measurement_id = os.environ.get("FIREBASE_MEASUREMENT_ID", "").strip()
    google_client_id = os.environ.get("FIREBASE_WEB_GOOGLE_CLIENT_ID", "").strip()
    app_check_site_key = os.environ.get("FIREBASE_APPCHECK_SITE_KEY", "").strip()
    enable_firebase_env = os.environ.get("ENABLE_FIREBASE", "true").strip().lower()
    firebase_allowed = enable_firebase_env not in ("false", "0", "no")
    firebase_ready = bool(firebase_allowed and api_key and project_id and app_id)
    firebase_config = (
        {
            "apiKey": api_key,
            "authDomain": auth_domain,
            "projectId": project_id,
            "storageBucket": storage_bucket,
            "messagingSenderId": messaging_sender_id,
            "appId": app_id,
            "measurementId": measurement_id,
            "googleClientId": google_client_id,
        }
        if firebase_ready
        else None
    )

    return {
        "API_BASE_URL": os.environ.get("PUBLIC_API_BASE_URL", "/api").strip() or "/api",
        "ENVIRONMENT": os.environ.get("ENVIRONMENT", "production"),
        "FIREBASE_APPCHECK_SITE_KEY": app_check_site_key,
        "FIREBASE_CONFIG": firebase_config,
        "FIREBASE_ENABLED": firebase_ready,
    }


def _script_safe_json(payload: dict[str, Any]) -> str:
    """Serialize for embedding inside a <script> element.

    A value carrying "</script>" would otherwise close the element early and
    turn everything after it into markup the browser executes. Escaping the
    three characters that can start a tag or a comment keeps the text valid JSON
    while making that impossible.
    """
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return encoded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def _mount_frontend(app: FastAPI) -> None:
    for prefix, folder in (
        ("/css", FRONTEND / "css"),
        ("/js", FRONTEND / "js"),
        ("/dist", FRONTEND / "dist"),
        ("/assets", FRONTEND / "assets"),
    ):
        if folder.exists():
            app.mount(prefix, StaticFiles(directory=str(folder)), name=prefix.strip("/"))

    # Root-level assets. index.html references /site.webmanifest and /favicon.ico
    # at the root, but the mounts above only cover subdirectories, so every page
    # load logged two 404s. Listed explicitly rather than mounting the whole
    # frontend directory at "/", which would also expose index.html unprocessed
    # and bypass the bootstrap injection below.
    for _name, _media in (
        ("favicon.ico", "image/x-icon"),
        ("site.webmanifest", "application/manifest+json"),
        ("robots.txt", "text/plain"),
        ("sitemap.xml", "application/xml"),
        ("privacy.html", "text/html"),
        ("terms.html", "text/html"),
    ):
        _path = FRONTEND / _name
        if not _path.exists():
            continue

        def _serve(path: Path = _path, media: str = _media) -> Response:
            return FileResponse(str(path), media_type=media)

        app.get(f"/{_name}", include_in_schema=False)(_serve)

    @app.get("/")
    def index() -> Response:
        index_file = FRONTEND / "index.html"
        if not index_file.exists():
            return HTMLResponse("<!DOCTYPE html><html><body>Missing index.html</body></html>", status_code=404)

        raw_html = index_file.read_text(encoding="utf-8")
        bootstrap_json = _script_safe_json(_build_public_bootstrap_payload())

        # Tier-1 Document Bootstrapping (Zero Network Waterfall):
        # 1. Non-executable, immutable, CSP-compliant JSON script block
        # 2. Synchronous window freeze for instant hydration
        bootstrap_block = (
            f'<script id="__MINDPAL_BOOTSTRAP__" type="application/json">{bootstrap_json}</script>\n'
            f'    <script>window.MINDPAL_CONFIG = Object.freeze({bootstrap_json});</script>'
        )

        target = '<script id="__MINDPAL_BOOTSTRAP__" type="application/json">{}</script>'
        if target in raw_html:
            rendered = raw_html.replace(target, bootstrap_block, 1)
        else:
            rendered = raw_html.replace("</head>", f"    {bootstrap_block}\n</head>", 1)

        return HTMLResponse(content=rendered, headers={"Cache-Control": "no-cache, must-revalidate"})


app = create_app()
