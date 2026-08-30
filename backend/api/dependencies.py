# backend/api/dependencies.py

"""
FastAPI dependency injection layer.

This module provides:
- ServiceContainer: singleton composition root for all backend services (re-exported from bootstrap)
- RequestContext: per-request metadata (request_id, locale, channel, session)
- Header extraction dependencies (locale, channel, request_id, session)
- Shared API helpers (error conversion, auth assertion)

Design rules:
- All configuration reads come from Settings (no os.getenv)
- Importing this module must not call external APIs or verify auth tokens
- Service construction is lazy (on first request)

Service container is built using the modular bootstrap package (backend.services.bootstrap)
which provides clear dependency ordering and extensibility.
"""

from __future__ import annotations

from dataclasses import dataclass

import hashlib
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Request, status

from backend.core.config import Settings, get_settings
from backend.core.errors import AppError
from backend.core.security import generate_request_id, normalize_locale, sanitize_text
from backend.models.user import UserChannel, UserSession
from backend.services.bootstrap import (
    ServiceContainer,
    build_service_container as bootstrap_build_service_container,
)


MAX_HEADER_CHARS = 512
MAX_REQUEST_ID_HEADER_CHARS = 120
MAX_CHANNEL_HEADER_CHARS = 80
MAX_LOCALE_HEADER_CHARS = 40
MAX_ANONYMOUS_USER_HEADER_CHARS = 160


# ═══════════════════════════════════════════════════════════════
# Service Container (re-exported from bootstrap)
# ═══════════════════════════════════════════════════════════════

# ServiceContainer is imported from backend.services.bootstrap
# See backend/services/bootstrap/__init__.py for the definition
__all__ = ["ServiceContainer"]


@dataclass(frozen=True, slots=True)
class RequestContext:
    request_id: str
    locale: str
    channel: UserChannel
    session: UserSession
    client_ip_hash: str
    timezone: str = "UTC"


# ═══════════════════════════════════════════════════════════════
# Service Container Singleton
# ═══════════════════════════════════════════════════════════════

_service_container: ServiceContainer | None = None


def build_service_container(settings: Settings) -> ServiceContainer:
    """
    Build one isolated composition root from an explicit Settings object.
    
    This is a convenience wrapper around the modular bootstrap package.
    The actual service building logic lives in backend.services.bootstrap.
    
    Args:
        settings: Application settings
        
    Returns:
        Fully initialized ServiceContainer ready for use
    """
    return bootstrap_build_service_container(settings)


def get_service_container() -> ServiceContainer:
    """Compatibility singleton for scripts outside an HTTP application."""
    global _service_container
    if _service_container is None:
        _service_container = build_service_container(get_settings())
    return _service_container


async def close_service_container() -> None:
    """Close the compatibility singleton used outside FastAPI requests."""
    global _service_container
    container = _service_container
    _service_container = None
    if container is not None:
        await container.aclose()


def reset_service_container_for_tests() -> None:
    """Clear the compatibility singleton for test isolation."""
    global _service_container
    _service_container = None


def get_services(request: Request) -> ServiceContainer:
    """Resolve the service container owned by the current FastAPI app."""
    container = getattr(request.app.state, "service_container", None)
    if container is None:
        settings = getattr(request.app.state, "settings", None) or get_settings()
        container = build_service_container(settings)
        request.app.state.service_container = container
    return container


ServicesDep = Annotated[ServiceContainer, Depends(get_services)]


# ═══════════════════════════════════════════════════════════════
# Header Extraction Dependencies
# ═══════════════════════════════════════════════════════════════

def get_request_id(
    request: Request,
    x_request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> str:
    # The HTTP middleware creates the canonical request ID before dependency
    # resolution. Reuse it so response headers, logs, idempotency, and JSON
    # bodies always reference the same trace.
    middleware_id = sanitize_text(
        str(getattr(request.state, "request_id", "") or ""),
        MAX_REQUEST_ID_HEADER_CHARS,
    )
    cleaned = sanitize_text(str(x_request_id or ""), MAX_REQUEST_ID_HEADER_CHARS)
    return middleware_id or cleaned or generate_request_id()


def get_locale(
    accept_language: Annotated[str | None, Header(alias="Accept-Language")] = None,
    x_mindpal_locale: Annotated[str | None, Header(alias="X-MindPal-Locale")] = None,
) -> str:
    explicit_locale = sanitize_text(str(x_mindpal_locale or ""), MAX_LOCALE_HEADER_CHARS)

    if explicit_locale:
        return normalize_locale(explicit_locale)

    accepted = sanitize_text(str(accept_language or ""), MAX_HEADER_CHARS)

    if not accepted:
        return "auto"

    first_locale = accepted.split(",", 1)[0].split(";", 1)[0].strip()
    return normalize_locale(first_locale)


def get_timezone(
    x_mindpal_timezone: Annotated[str | None, Header(alias="X-MindPal-Timezone")] = None,
) -> str:
    """
    Resolve user timezone from X-MindPal-Timezone header.
    
    Validates that it's an IANA timezone (e.g. "America/New_York", "Europe/London", "UTC").
    Falls back to "UTC" if not provided or invalid.
    
    Frontend should pass Intl.DateTimeFormat().resolvedOptions().timeZone
    """
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    
    if not x_mindpal_timezone:
        return "UTC"
    
    cleaned = sanitize_text(str(x_mindpal_timezone), MAX_LOCALE_HEADER_CHARS)
    
    if not cleaned:
        return "UTC"
    
    # Validate it's a real IANA timezone
    try:
        ZoneInfo(cleaned)
        return cleaned
    except ZoneInfoNotFoundError:
        # Invalid timezone, fall back to UTC
        return "UTC"


def get_channel(
    x_mindpal_channel: Annotated[str | None, Header(alias="X-MindPal-Channel")] = None,
) -> UserChannel:
    raw_channel = sanitize_text(str(x_mindpal_channel or "web"), MAX_CHANNEL_HEADER_CHARS)

    try:
        return UserChannel(raw_channel)
    except ValueError:
        return UserChannel.UNKNOWN


def get_anonymous_user_id(
    x_mindpal_user_id: Annotated[str | None, Header(alias="X-MindPal-User-ID")] = None,
) -> str:
    cleaned = sanitize_text(
        str(x_mindpal_user_id or "anonymous"),
        MAX_ANONYMOUS_USER_HEADER_CHARS,
    )
    return cleaned or "anonymous"


# ═══════════════════════════════════════════════════════════════
# Session Resolution Dependencies
# ═══════════════════════════════════════════════════════════════

async def get_current_session(
    services: ServicesDep,
    locale: Annotated[str, Depends(get_locale)],
    channel: Annotated[UserChannel, Depends(get_channel)],
    anonymous_user_id: Annotated[str, Depends(get_anonymous_user_id)],
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    x_firebase_app_check: Annotated[str | None, Header(alias="X-Firebase-AppCheck")] = None,
) -> UserSession:
    """
    Resolve either:
    - verified Firebase session when Authorization: Bearer <id_token> exists
    - anonymous guest session when no Authorization exists and anonymous is enabled

    Invalid Bearer tokens fail closed in AuthService.
    """
    session = await services.auth.resolve_session(
        authorization_header=authorization,
        raw_user_id=anonymous_user_id,
        channel=channel,
        locale=locale,
        require_auth=False,
    )
    if session.authenticated and services.settings.REQUIRE_FIREBASE_APP_CHECK:
        await services.auth.verify_app_check_token(x_firebase_app_check)
    return session


async def require_authenticated_session(
    services: ServicesDep,
    locale: Annotated[str, Depends(get_locale)],
    channel: Annotated[UserChannel, Depends(get_channel)],
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    x_firebase_app_check: Annotated[str | None, Header(alias="X-Firebase-AppCheck")] = None,
) -> UserSession:
    """
    Resolve verified Firebase session only.
    """
    session = await services.auth.resolve_session(
        authorization_header=authorization,
        raw_user_id=None,
        channel=channel,
        locale=locale,
        require_auth=True,
    )
    if services.settings.REQUIRE_FIREBASE_APP_CHECK:
        await services.auth.verify_app_check_token(x_firebase_app_check)
    return session


SessionDep = Annotated[UserSession, Depends(get_current_session)]
RequiredSessionDep = Annotated[UserSession, Depends(require_authenticated_session)]
RequestIdDep = Annotated[str, Depends(get_request_id)]
LocaleDep = Annotated[str, Depends(get_locale)]
TimezoneDep = Annotated[str, Depends(get_timezone)]
ChannelDep = Annotated[UserChannel, Depends(get_channel)]


# ═══════════════════════════════════════════════════════════════
# Request Context Dependencies
# ═══════════════════════════════════════════════════════════════

async def get_request_context(
    request: Request,
    request_id: RequestIdDep,
    locale: LocaleDep,
    timezone: TimezoneDep,
    channel: ChannelDep,
    session: SessionDep,
) -> RequestContext:
    request.state.request_id = request_id
    request.state.locale = locale
    request.state.channel = channel.value
    request.state.user_id_hash = session.user_id_hash
    request.state.authenticated = session.authenticated

    client_host = request.client.host if request.client else "unknown"
    client_ip_hash = hashlib.sha256(client_host.encode("utf-8")).hexdigest()[:32]
    return RequestContext(
        request_id=request_id,
        locale=locale,
        timezone=timezone,
        channel=channel,
        session=session,
        client_ip_hash=client_ip_hash,
    )


async def get_authenticated_request_context(
    request: Request,
    request_id: RequestIdDep,
    locale: LocaleDep,
    timezone: TimezoneDep,
    channel: ChannelDep,
    session: RequiredSessionDep,
) -> RequestContext:
    request.state.request_id = request_id
    request.state.locale = locale
    request.state.channel = channel.value
    request.state.user_id_hash = session.user_id_hash
    request.state.authenticated = True

    client_host = request.client.host if request.client else "unknown"
    client_ip_hash = hashlib.sha256(client_host.encode("utf-8")).hexdigest()[:32]
    return RequestContext(
        request_id=request_id,
        locale=locale,
        timezone=timezone,
        channel=channel,
        session=session,
        client_ip_hash=client_ip_hash,
    )


RequestContextDep = Annotated[RequestContext, Depends(get_request_context)]
AuthenticatedRequestContextDep = Annotated[
    RequestContext,
    Depends(get_authenticated_request_context),
]


async def assert_admin(
    context: Any,
    authority: AdminAuthority | None = None,
) -> None:
    """Require administrator state from the configured trusted authority."""
    assert_authenticated(context)
    if authority is not None:
        if not await authority.is_admin(context.session):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "admin_access_required",
                    "message": "Administrative access is required for this operation",
                    "request_id": getattr(context, "request_id", None),
                },
            )
    else:
        session = getattr(context, "session", None)
        metadata = getattr(session, "metadata", {}) if session else {}
        is_admin = bool(metadata.get("admin", False)) if isinstance(metadata, dict) else False
        if not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "admin_access_required",
                    "message": "Administrative access is required for this operation",
                    "request_id": getattr(context, "request_id", None),
                },
            )


async def get_admin_request_context(
    context: AuthenticatedRequestContextDep,
    services: ServicesDep,
) -> RequestContext:
    await assert_admin(context, services.admin_authority)
    return context


AdminRequestContextDep = Annotated[
    RequestContext,
    Depends(get_admin_request_context),
]


# ═══════════════════════════════════════════════════════════════
# Shared API Helpers (used by all routers)
# ═══════════════════════════════════════════════════════════════

def assert_authenticated(context: Any) -> None:
    """
    Raise 401 if the request context does not have an authenticated session.

    Use this in any router that requires Firebase authentication.
    """
    session = getattr(context, "session", None)

    if session is None or not getattr(session, "authenticated", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "authentication_required",
                "message": "Authentication is required for this operation",
                "request_id": getattr(context, "request_id", None),
            },
        )


def http_error_from_app_error(
    exc: AppError,
    *,
    request_id: str | None = None,
) -> HTTPException:
    """
    Convert an AppError into a FastAPI HTTPException.

    Extracts status_code, error code, and sanitized message from the exception.
    Use this in router except blocks to convert AppError → HTTP response.
    """
    status_code = getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR
    code = getattr(exc, "code", None) or exc.__class__.__name__
    message = sanitize_text(str(exc), 500) or "Application error"
    details = getattr(exc, "details", None) or {}

    detail: dict[str, Any] = {
        "code": code,
        "message": message,
        "details": details,
    }
    if request_id:
        detail["request_id"] = request_id

    retry_after = details.get("retry_after_seconds") if isinstance(details, dict) else None
    if retry_after is None and isinstance(details, dict):
        usage = details.get("usage")
        if isinstance(usage, dict):
            # Quota exhaustion is also a 429. Expose its actual reset time so a
            # resilient client pauses instead of hammering a provider operation.
            retry_after = usage.get("reset_5h_seconds")
    headers = None
    try:
        retry_after_seconds = max(1, int(retry_after)) if retry_after is not None else 0
        if retry_after_seconds:
            headers = {"Retry-After": str(retry_after_seconds)}
    except (TypeError, ValueError):
        headers = None

    return HTTPException(
        status_code=status_code,
        detail=detail,
        headers=headers,
    )