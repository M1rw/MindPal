# backend/main.py

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

from backend.configs.app import csv_env, is_production
from backend.configs.auth import firebase_public_bootstrap
from backend.configs.runtime import validate_runtime_configs
from backend.configs.settings import get_settings
from backend.infra.store.store import storage_health
from backend.infra.observability.metrics import (
    VoiceMetric,
    set_request_id,
    voice_metrics,
)
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
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

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
        "font-src 'self' data: https://fonts.gstatic.com https://vercel.live",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        # accounts.google.com serves the Google Sign-In client, which was also
        # being refused — and live voice needs a signed-in account.
        "script-src 'self' 'unsafe-inline' blob: https://www.gstatic.com https://apis.google.com https://accounts.google.com https://vercel.live",
        "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://vercel.live",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "connect-src 'self' https: wss:",
        "upgrade-insecure-requests",
    )
)


def configured_cors_origins() -> list[str]:
    """Explicit origins only. A wildcard is dropped with a warning, never honoured."""
    origins = []
    for origin in csv_env(CORS_ORIGINS_ENV):
        if origin == "*":
            logger.error(
                "cors_wildcard_refused env=%s — list exact origins instead", CORS_ORIGINS_ENV
            )
            continue
        origins.append(origin)
    return origins


def _static_asset(path: Path, media: str):
    """A zero-argument handler bound to one fixed file.

    The previous loop captured the file with default arguments
    (`def _serve(path=_path, media=_media)`). FastAPI exposes every handler
    parameter as a query parameter, so `/robots.txt?path=/any/file` read any
    file the process could open. Nothing about the response may come from the
    request.
    """

    def serve() -> Response:
        return FileResponse(str(path), media_type=media)

    return serve


def create_app(*, serve_frontend: bool = True) -> FastAPI:
    validate_runtime_configs()  # a broken bundled config is a bad build: fail loudly
    try:
        get_settings().validate_runtime()
    except ValueError as exc:
        # Storage settings. The store module has already fallen back to
        # UnavailableStore, so start and let /api/health name what is missing
        # instead of answering every page, sign-in included, with a bare 500.
        logger.critical("storage_config_invalid reason=%s", exc)
    # Metrics are aggregated per instance-minute by the platform pulse
    # (backend/infra/observability/pulse.py); one document per LLM call or voice
    # request is no longer written.
    app = FastAPI(title="MindPal", version="5.0.0", docs_url=None, redoc_url=None)

    allowed_hosts = csv_env(ALLOWED_HOSTS_ENV)
    if allowed_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    elif is_production():
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
            # Idempotency-Key: chat and voice routes accept it for safe retries.
            allow_headers=["Authorization", "Content-Type", "X-Request-Id", "X-Firebase-AppCheck", "Idempotency-Key"],
            max_age=600,
        )

    @app.on_event("startup")
    def report_storage_health() -> None:
        # Report, never crash: on serverless a cold-start blip would otherwise
        # take the whole deployment down. /api/health/ready returns 503 while
        # degraded, and limit enforcement fails closed until the store recovers.
        health = storage_health()
        if health.get("status") != "ok":
            logger.error("storage_degraded_at_startup health=%s", health)
        else:
            logger.info("storage_ready provider=%s", health.get("provider"))

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        candidate = request.headers.get("x-request-id", "").strip()
        request_id = candidate if _REQUEST_ID_PATTERN.fullmatch(candidate) else f"req_{uuid.uuid4().hex[:16]}"
        set_request_id(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            if request.url.path.startswith("/api/voice/"):
                voice_metrics().record(
                    VoiceMetric(
                        operation=_voice_operation(request.url.path),
                        duration_ms=max(0, int((time.perf_counter() - started) * 1000)),
                        outcome="exception",
                        status_code=500,
                    )
                )
            raise
        response.headers["X-Request-Id"] = request_id
        if request.url.path.startswith("/api/voice/"):
            voice_metrics().record(
                VoiceMetric(
                    operation=_voice_operation(request.url.path),
                    duration_ms=max(0, int((time.perf_counter() - started) * 1000)),
                    outcome=_voice_outcome(response.status_code),
                    status_code=response.status_code,
                )
            )
        logger.info(
            "http_request request_id=%s method=%s path=%s status=%s duration_ms=%s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            max(0, int((time.perf_counter() - started) * 1000)),
        )
        return response

    @app.middleware("http")
    async def add_security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        response.headers["Cross-Origin-Opener-Policy"] = "unsafe-none"
        response.headers["Permissions-Policy"] = "geolocation=(self), camera=(), payment=(), usb=()"
        if is_production():
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    wire_http(app)
    if serve_frontend and FRONTEND.exists():
        _mount_frontend(app)
    return app


def _voice_operation(path: str) -> str:
    suffix = path.removeprefix("/api/voice/").strip("/")
    return {
        "session-token": "mint",
        "session-events": "event",
        "usage": "usage",
        "analytics": "analytics",
        "audit": "audit",
        "summarize": "summarize",
        "reaction": "reaction",
        "recall": "recall",
    }.get(suffix, "unknown")


def _voice_outcome(status_code: int) -> str:
    if status_code < 400:
        return "success"
    if status_code == 401:
        return "unauthenticated"
    if status_code == 409:
        return "conflict"
    if status_code == 429:
        return "quota_exceeded"
    if status_code >= 500:
        return "unavailable"
    return "failure"


def _build_public_bootstrap_payload() -> dict[str, Any]:
    """Generates the non-secret client runtime bootstrap configuration."""
    return firebase_public_bootstrap()


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
        app.get(f"/{_name}", include_in_schema=False)(_static_asset(_path, _media))

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
