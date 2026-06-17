# backend/api/dependencies.py

"""
FastAPI dependency injection layer.

This module provides:
- ServiceContainer: singleton composition root for all backend services
- RequestContext: per-request metadata (request_id, locale, channel, session)
- Header extraction dependencies (locale, channel, request_id, session)
- Shared API helpers (error conversion, auth assertion)

Design rules:
- All configuration reads come from Settings (no os.getenv)
- Importing this module must not call external APIs or verify auth tokens
- Service construction is lazy (on first request)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Request, status

from backend.core.config import Settings, get_settings
from backend.core.errors import AppError
from backend.core.security import generate_request_id, normalize_locale, sanitize_text
from backend.models.user import UserChannel, UserSession
from backend.providers import (
    build_llm_providers,
    build_tts_providers,
)
from backend.services import (
    AuthService,
    DBService,
    LLMService,
    MemoryService,
    OutputGuardService,
    RAGService,
    SafetyService,
    TTSService,
)


MAX_HEADER_CHARS = 512
MAX_REQUEST_ID_HEADER_CHARS = 120
MAX_CHANNEL_HEADER_CHARS = 80
MAX_LOCALE_HEADER_CHARS = 40
MAX_ANONYMOUS_USER_HEADER_CHARS = 160


# ═══════════════════════════════════════════════════════════════
# Service Container
# ═══════════════════════════════════════════════════════════════

@dataclass(slots=True)
class ServiceContainer:
    """
    API composition root.

    Importing this module must not:
    - call external LLM APIs
    - verify auth tokens
    - read/write databases
    - synthesize audio
    """

    settings: Settings
    auth: AuthService
    db: DBService
    llm: LLMService
    memory: MemoryService
    output_guard: OutputGuardService
    rag: RAGService
    safety: SafetyService
    tts: TTSService

    async def health(self) -> dict[str, object]:
        db_health = await self.db.health()

        return {
            "settings_loaded": True,
            "environment": self.settings.ENVIRONMENT,
            "production_mode": self.settings.is_production,
            "auth": self.auth.health(),
            "db": db_health,
            "llm": self.llm.health(),
            "memory": self.memory.health(),
            "output_guard": self.output_guard.health(),
            "rag": self.rag.health(),
            "safety": self.safety.health(),
            "tts": self.tts.health(),
        }


@dataclass(frozen=True, slots=True)
class RequestContext:
    request_id: str
    locale: str
    channel: UserChannel
    session: UserSession


# ═══════════════════════════════════════════════════════════════
# Service Container Singleton
# ═══════════════════════════════════════════════════════════════

_service_container: ServiceContainer | None = None


def get_service_container() -> ServiceContainer:
    """
    Return singleton service container for the FastAPI process.

    Production-safe defaults:
    - Firebase Auth is built by AuthService.
    - Firebase Firestore is built by DBService.
    - Anonymous sessions are env-driven, not hardcoded.
    - Offline/browser fallbacks are env-driven, not hidden.
    """
    global _service_container
    if _service_container is not None:
        return _service_container

    settings = get_settings()

    llm_providers = build_llm_providers(settings)
    llm = LLMService(
        providers=llm_providers,
        settings=settings,
        include_offline_provider=settings.ENABLE_OFFLINE_LLM_FALLBACK,
    )

    auth = AuthService(
        settings=settings,
        allow_anonymous=settings.ALLOW_ANONYMOUS_SESSIONS,
    )

    db = DBService(settings=settings)

    tts_providers = build_tts_providers(settings)
    tts = TTSService(
        providers=tts_providers,
        settings=settings,
        include_browser_fallback=settings.ENABLE_BROWSER_TTS_FALLBACK,
    )

    memory = MemoryService(
        settings=settings,
        llm_service=llm,
        enable_llm_summarization=settings.ENABLE_LLM_MEMORY_SUMMARIZATION,
    )

    output_guard = OutputGuardService(
        llm_service=llm,
        enable_llm_rewrite=settings.ENABLE_LLM_OUTPUT_REWRITE,
    )

    rag = RAGService(
        llm_service=llm,
        enable_llm_planning=settings.ENABLE_LLM_RAG_PLANNING,
    )

    safety = SafetyService(
        llm_service=llm,
        enable_llm_ambiguity_classifier=settings.ENABLE_LLM_SAFETY_CLASSIFIER,
    )

    _service_container = ServiceContainer(
        settings=settings,
        auth=auth,
        db=db,
        llm=llm,
        memory=memory,
        output_guard=output_guard,
        rag=rag,
        safety=safety,
        tts=tts,
    )

    return _service_container


def reset_service_container_for_tests() -> None:
    """Clear the cached service container for test isolation."""
    global _service_container
    _service_container = None


def get_services() -> ServiceContainer:
    return get_service_container()


ServicesDep = Annotated[ServiceContainer, Depends(get_services)]


# ═══════════════════════════════════════════════════════════════
# Header Extraction Dependencies
# ═══════════════════════════════════════════════════════════════

def get_request_id(
    x_request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> str:
    cleaned = sanitize_text(str(x_request_id or ""), MAX_REQUEST_ID_HEADER_CHARS)
    return cleaned or generate_request_id()


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
) -> UserSession:
    """
    Resolve either:
    - verified Firebase session when Authorization: Bearer <id_token> exists
    - anonymous guest session when no Authorization exists and anonymous is enabled

    Invalid Bearer tokens fail closed in AuthService.
    """
    return await services.auth.resolve_session(
        authorization_header=authorization,
        raw_user_id=anonymous_user_id,
        channel=channel,
        locale=locale,
        require_auth=False,
    )


async def require_authenticated_session(
    services: ServicesDep,
    locale: Annotated[str, Depends(get_locale)],
    channel: Annotated[UserChannel, Depends(get_channel)],
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> UserSession:
    """
    Resolve verified Firebase session only.
    """
    return await services.auth.resolve_session(
        authorization_header=authorization,
        raw_user_id=None,
        channel=channel,
        locale=locale,
        require_auth=True,
    )


SessionDep = Annotated[UserSession, Depends(get_current_session)]
RequiredSessionDep = Annotated[UserSession, Depends(require_authenticated_session)]
RequestIdDep = Annotated[str, Depends(get_request_id)]
LocaleDep = Annotated[str, Depends(get_locale)]
ChannelDep = Annotated[UserChannel, Depends(get_channel)]


# ═══════════════════════════════════════════════════════════════
# Request Context Dependencies
# ═══════════════════════════════════════════════════════════════

async def get_request_context(
    request: Request,
    request_id: RequestIdDep,
    locale: LocaleDep,
    channel: ChannelDep,
    session: SessionDep,
) -> RequestContext:
    request.state.request_id = request_id
    request.state.locale = locale
    request.state.channel = channel.value
    request.state.user_id_hash = session.user_id_hash
    request.state.authenticated = session.authenticated

    return RequestContext(
        request_id=request_id,
        locale=locale,
        channel=channel,
        session=session,
    )


async def get_authenticated_request_context(
    request: Request,
    request_id: RequestIdDep,
    locale: LocaleDep,
    channel: ChannelDep,
    session: RequiredSessionDep,
) -> RequestContext:
    request.state.request_id = request_id
    request.state.locale = locale
    request.state.channel = channel.value
    request.state.user_id_hash = session.user_id_hash
    request.state.authenticated = True

    return RequestContext(
        request_id=request_id,
        locale=locale,
        channel=channel,
        session=session,
    )


RequestContextDep = Annotated[RequestContext, Depends(get_request_context)]
AuthenticatedRequestContextDep = Annotated[
    RequestContext,
    Depends(get_authenticated_request_context),
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

    return HTTPException(
        status_code=status_code,
        detail=detail,
    )