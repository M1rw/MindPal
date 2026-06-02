# backend/api/dependencies.py

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, Header, Request

from backend.core.config import Settings, get_settings
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
            "environment": _environment(self.settings),
            "production_mode": _is_production(self.settings),
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


@lru_cache(maxsize=1)
def get_service_container() -> ServiceContainer:
    """
    Return singleton service container for the FastAPI process.

    Production-safe defaults:
    - Firebase Auth is built by AuthService.
    - Firebase Firestore is built by DBService.
    - Anonymous sessions are env-driven, not hardcoded.
    - Offline/browser fallbacks are env-driven, not hidden.
    """
    settings = get_settings()

    llm_providers = build_llm_providers(settings)
    llm = LLMService(
        providers=llm_providers,
        settings=settings,
        include_offline_provider=_settings_bool(
            settings,
            "ENABLE_OFFLINE_LLM_FALLBACK",
            default=True,
        ),
    )

    auth = AuthService(
        settings=settings,
        allow_anonymous=_settings_bool(
            settings,
            "ALLOW_ANONYMOUS_SESSIONS",
            default=True,
        ),
    )

    db = DBService(settings=settings)

    tts_providers = build_tts_providers(settings)
    tts = TTSService(
        providers=tts_providers,
        settings=settings,
        include_browser_fallback=_settings_bool(
            settings,
            "ENABLE_BROWSER_TTS_FALLBACK",
            default=True,
        ),
    )

    memory = MemoryService(
        settings=settings,
        llm_service=llm,
        enable_llm_summarization=_settings_bool(
            settings,
            "ENABLE_LLM_MEMORY_SUMMARIZATION",
            default=True,
        ),
    )

    output_guard = OutputGuardService(
        llm_service=llm,
        enable_llm_rewrite=_settings_bool(
            settings,
            "ENABLE_LLM_OUTPUT_REWRITE",
            default=True,
        ),
    )

    rag = RAGService(
        llm_service=llm,
        enable_llm_planning=_settings_bool(
            settings,
            "ENABLE_LLM_RAG_PLANNING",
            default=True,
        ),
    )

    safety = SafetyService(
        llm_service=llm,
        enable_llm_ambiguity_classifier=_settings_bool(
            settings,
            "ENABLE_LLM_SAFETY_CLASSIFIER",
            default=True,
        ),
    )

    return ServiceContainer(
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


def reset_service_container_for_tests() -> None:
    get_service_container.cache_clear()


def get_services() -> ServiceContainer:
    return get_service_container()


ServicesDep = Annotated[ServiceContainer, Depends(get_services)]


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


def _settings_value(settings: Settings, name: str, default: Any = None) -> Any:
    value = getattr(settings, name, None)

    if value is None:
        return os.getenv(name, default)

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def _settings_bool(settings: Settings, name: str, *, default: bool) -> bool:
    value = _settings_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _environment(settings: Settings) -> str:
    value = _settings_value(settings, "ENVIRONMENT", "development")
    return sanitize_text(str(value or "development"), 80).lower()


def _is_production(settings: Settings) -> bool:
    return _environment(settings) in {"production", "prod"}