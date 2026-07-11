# backend/main.py

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.api import api_router
from backend.api.dependencies import close_service_container, get_service_container, reset_service_container_for_tests
from backend.core.config import Settings, get_settings
from backend.core.errors import AppError
from backend.core.middleware import RequestBodyLimitMiddleware
from backend.core.security import generate_request_id, sanitize_text


MAX_ERROR_MESSAGE_CHARS = 700
MAX_DETAIL_CHARS = 1_500
MAX_HEADER_CHARS = 120

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
logger = logging.getLogger("mindpal.request")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    App lifecycle.

    Starts/stops only local infrastructure. Provider SDKs remain lazy and are
    not called here.
    """
    try:
        yield
    finally:
        container = getattr(app.state, "service_container", None)
        app.state.service_container = None
        if container is not None:
            await container.aclose()
        await close_service_container()


def create_app(settings: Settings | None = None) -> FastAPI:
    """
    FastAPI app factory.

    Importing backend.main is safe:
    - no external LLM call
    - no Firebase initialization
    - no DB read/write
    - no TTS synthesis
    """
    settings = settings or get_settings()

    app = FastAPI(
        title=_setting_text(settings, "PROJECT_NAME", "MindPal"),
        version=_setting_text(settings, "VERSION", "2.0.0"),
        description="MindPal backend API",
        lifespan=lifespan,
        docs_url=_docs_url(settings),
        redoc_url=_redoc_url(settings),
        openapi_url=_openapi_url(settings),
    )
    app.state.settings = settings
    app.state.service_container = None

    _install_middleware(app, settings)
    _install_exception_handlers(app)
    _install_routes(app)

    return app


def _install_middleware(app: FastAPI, settings: Settings) -> None:
    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=int(getattr(settings, "MAX_REQUEST_BODY_BYTES", 20_000_000)),
    )

    trusted_hosts = _string_list_setting(
        settings,
        "TRUSTED_HOSTS",
        default=["*"],
    )

    if trusted_hosts and trusted_hosts != ["*"]:
        app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=trusted_hosts,
        )

    cors_origins = _string_list_setting(
        settings,
        "CORS_ALLOW_ORIGINS",
        default=_string_list_setting(settings, "CORS_ORIGINS", default=["*"]),
    )

    # Same-origin is the secure production default. Cross-origin clients must
    # opt in through an explicit allowlist.
    environment = str(getattr(settings, "ENVIRONMENT", "development")).lower()
    if environment == "production" and cors_origins == ["*"]:
        cors_origins = []

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=cors_origins != ["*"],
        allow_methods=_string_list_setting(
            settings,
            "CORS_ALLOW_METHODS",
            default=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        ),
        allow_headers=_string_list_setting(
            settings,
            "CORS_ALLOW_HEADERS",
            default=["*"],
        ),
    )

    @app.middleware("http")
    async def request_context_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = sanitize_text(
            request.headers.get("X-Request-ID", ""),
            MAX_HEADER_CHARS,
        ) or generate_request_id()

        request.state.request_id = request_id

        started = time.perf_counter()

        try:
            response = await call_next(request)
        finally:
            elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
            request.state.process_time_ms = elapsed_ms

        response.headers["X-Request-ID"] = request_id
        response.headers["X-Process-Time-MS"] = str(getattr(request.state, "process_time_ms", "0"))
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        logger.info(
            "request_complete request_id=%s method=%s path=%s status=%s duration_ms=%s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            getattr(request.state, "process_time_ms", 0),
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "form-action 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob: https://*.googleusercontent.com; "
            "font-src 'self' data:; "
            "media-src 'self' data: blob:; "
            "worker-src 'self' blob:; "
            "frame-src https://*.firebaseapp.com https://accounts.google.com; "
            "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com "
            "https://*.firebaseapp.com https://*.vercel-insights.com "
            "wss://generativelanguage.googleapis.com; "
            "manifest-src 'self'"
        )

        if bool(getattr(settings, "ENABLE_HSTS", False)):
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        return response


def _install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        details = getattr(exc, "details", None) or {}
        headers: dict[str, str] = {}
        retry_after = details.get("retry_after_seconds") if isinstance(details, dict) else None
        if isinstance(retry_after, (int, float)) and retry_after > 0:
            headers["Retry-After"] = str(max(1, int(retry_after)))
        return JSONResponse(
            status_code=getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_payload(
                request=request,
                code=getattr(exc, "code", None) or exc.__class__.__name__,
                message=str(exc) or "Application error",
                details=details,
            ),
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_error_payload(
                request=request,
                code="validation_error",
                message="Request validation failed",
                details={
                    "errors": _sanitize_validation_errors(exc.errors()),
                },
            ),
        )

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail

        if isinstance(detail, dict):
            content = _sanitize_jsonish(detail)
            content.setdefault("request_id", _request_id(request))
            return JSONResponse(status_code=exc.status_code, content=content)

        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(
                request=request,
                code="http_error",
                message=str(detail or "HTTP error"),
                details={},
            ),
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "unhandled_request_error request_id=%s method=%s path=%s error_type=%s",
            _request_id(request),
            request.method,
            request.url.path,
            type(exc).__name__,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_payload(
                request=request,
                code="internal_server_error",
                message="Internal server error",
                details={},
            ),
        )


def _install_routes(app: FastAPI) -> None:
    app.include_router(api_router)
    _install_frontend_routes(app)


def _request_host(request: Request | None) -> str:
    if request is None:
        return ""

    hostname = getattr(request.url, "hostname", None)
    if hostname:
        return hostname

    host_header = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    if not host_header:
        return ""

    parsed = urlparse(host_header if host_header.startswith(("http://", "https://")) else f"//{host_header}")
    return parsed.hostname or host_header.split(":", 1)[0]


def _resolve_firebase_auth_domain(settings: Settings, request: Request | None = None) -> str:
    configured_domain = str(getattr(settings, "FIREBASE_AUTH_DOMAIN", "") or "").strip()
    environment = str(getattr(settings, "ENVIRONMENT", "development")).lower()
    request_host = _request_host(request)

    if not configured_domain:
        return request_host

    if environment == "production" and configured_domain.endswith(".firebaseapp.com"):
        return request_host or configured_domain

    return configured_domain


def _install_frontend_routes(app: FastAPI) -> None:
    """Install one deterministic frontend route map for local and serverless runs."""
    if not FRONTEND_DIR.exists():
        return

    static_mounts = {
        "/css": FRONTEND_DIR / "css",
        "/js": FRONTEND_DIR / "js",
        "/dist": FRONTEND_DIR / "dist",
        "/assets": FRONTEND_DIR / "assets",
    }

    for prefix, directory in static_mounts.items():
        if directory.exists():
            app.mount(
                prefix,
                StaticFiles(directory=str(directory)),
                name=f"frontend_{prefix.strip('/').replace('/', '_')}",
            )

    @app.get("/runtime-config.js", include_in_schema=False)
    async def runtime_config(request: Request) -> Response:
        settings = app.state.settings
        api_base_url = str(getattr(settings, "PUBLIC_API_BASE_URL", "") or "").strip() or "/api"
        firebase_config = {
            "apiKey": str(getattr(settings, "FIREBASE_WEB_API_KEY", "") or "").strip(),
            "authDomain": _resolve_firebase_auth_domain(settings, request),
            "databaseURL": str(getattr(settings, "FIREBASE_DATABASE_URL", "") or "").strip(),
            "projectId": str(getattr(settings, "FIREBASE_WEB_PROJECT_ID", "") or "").strip(),
            "storageBucket": str(getattr(settings, "FIREBASE_STORAGE_BUCKET", "") or "").strip(),
            "messagingSenderId": str(
                getattr(settings, "FIREBASE_MESSAGING_SENDER_ID", "") or ""
            ).strip(),
            "appId": str(getattr(settings, "FIREBASE_WEB_APP_ID", "") or "").strip(),
            "measurementId": str(
                getattr(settings, "FIREBASE_MEASUREMENT_ID", "") or ""
            ).strip(),
        }
        required_firebase_values = (
            firebase_config["apiKey"],
            firebase_config["authDomain"],
            firebase_config["projectId"],
            firebase_config["appId"],
        )
        payload = {
            "API_BASE_URL": api_base_url,
            "VOICE_DEBUG": False,
            "SHOW_RESPONSE_DEBUG": False,
            "FIREBASE_APPCHECK_SITE_KEY": str(
                getattr(settings, "FIREBASE_APPCHECK_SITE_KEY", "") or ""
            ).strip(),
            "FIREBASE_CONFIG": firebase_config if all(required_firebase_values) else None,
            "FIREBASE_ENABLED": bool(
                getattr(settings, "ENABLE_FIREBASE", False)
                and all(required_firebase_values)
            ),
        }
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        script = (
            "(() => { const config = "
            + serialized
            + "; if (config.FIREBASE_CONFIG) { "
              "config.FIREBASE_CONFIG = Object.freeze(config.FIREBASE_CONFIG); } "
              "window.MINDPAL_CONFIG = Object.freeze(config); })();"
        )
        return Response(
            content=script,
            media_type="text/javascript; charset=utf-8",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon_ico() -> FileResponse:
        return FileResponse(
            FRONTEND_DIR / "favicon.ico",
            media_type="image/x-icon",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @app.get("/site.webmanifest", include_in_schema=False)
    async def site_webmanifest() -> FileResponse:
        return FileResponse(
            FRONTEND_DIR / "site.webmanifest",
            media_type="application/manifest+json",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    @app.get("/robots.txt", include_in_schema=False)
    async def robots_txt() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "robots.txt", media_type="text/plain; charset=utf-8")

    @app.get("/sitemap.xml", include_in_schema=False)
    async def sitemap_xml() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "sitemap.xml", media_type="application/xml")

    @app.get("/ui", include_in_schema=False)
    @app.get("/", include_in_schema=False)
    async def frontend_index() -> FileResponse:
        return FileResponse(
            FRONTEND_DIR / "index.html",
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-cache"},
        )


def _error_payload(
    *,
    request: Request,
    code: str,
    message: str,
    details: dict[str, Any],
) -> dict[str, Any]:
    return {
        "code": sanitize_text(code, 120) or "error",
        "message": sanitize_text(message, MAX_ERROR_MESSAGE_CHARS) or "Error",
        "details": _sanitize_jsonish(details),
        "request_id": _request_id(request),
    }


def _sanitize_validation_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []

    for error in errors[:20]:
        sanitized.append(
            {
                "type": sanitize_text(str(error.get("type", "")), 120),
                "loc": [
                    sanitize_text(str(item), 120)
                    for item in error.get("loc", [])
                ],
                "msg": sanitize_text(str(error.get("msg", "")), 300),
            }
        )

    return sanitized


def _sanitize_jsonish(value: Any, *, depth: int = 4) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return sanitize_text(value, MAX_DETAIL_CHARS)

    if depth <= 0:
        return sanitize_text(str(value), MAX_DETAIL_CHARS)

    if isinstance(value, dict):
        return {
            sanitize_text(str(key), 120): _sanitize_jsonish(item, depth=depth - 1)
            for key, item in list(value.items())[:40]
            if sanitize_text(str(key), 120)
        }

    if isinstance(value, list):
        return [_sanitize_jsonish(item, depth=depth - 1) for item in value[:40]]

    return sanitize_text(str(value), MAX_DETAIL_CHARS)


def _request_id(request: Request) -> str:
    return sanitize_text(
        str(getattr(request.state, "request_id", "") or ""),
        MAX_HEADER_CHARS,
    ) or generate_request_id()


def _setting_text(settings: Settings, name: str, default: str) -> str:
    value = getattr(settings, name, default)
    return sanitize_text(str(value or default), 120) or default


def _string_list_setting(
    settings: Settings,
    name: str,
    *,
    default: list[str],
) -> list[str]:
    value = getattr(settings, name, None)

    if value is None:
        return default

    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_items = list(value)
    else:
        return default

    cleaned = [
        sanitize_text(str(item), 300)
        for item in raw_items
        if sanitize_text(str(item), 300)
    ]

    return cleaned or default


def _is_docs_enabled(settings: Settings) -> bool:
    """Docs are enabled only when ENABLE_DOCS is explicitly True or ENVIRONMENT is development."""
    explicit = getattr(settings, "ENABLE_DOCS", None)
    if explicit is not None:
        return bool(explicit)
    # Default: enabled in development, disabled everywhere else.
    environment = str(getattr(settings, "ENVIRONMENT", "development")).lower()
    return environment in {"development", "dev", "local"}


def _docs_url(settings: Settings) -> str | None:
    return "/docs" if _is_docs_enabled(settings) else None


def _redoc_url(settings: Settings) -> str | None:
    return "/redoc" if _is_docs_enabled(settings) else None


def _openapi_url(settings: Settings) -> str | None:
    return "/openapi.json" if _is_docs_enabled(settings) else None


app = create_app()


__all__ = [
    "app",
    "create_app",
    "get_service_container",
    "reset_service_container_for_tests",
]

