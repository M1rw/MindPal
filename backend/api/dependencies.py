# backend/api/dependencies.py

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, Request

from backend.core.config import Settings, get_settings
from backend.core.security import generate_request_id, normalize_locale, sanitize_text
from backend.models.user import UserChannel, UserSession
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

    Provider SDK adapters can be injected here later without changing routers.
    This module must not import Gemini/Firebase/Camb.ai SDKs directly.
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

    Default mode:
    - no external provider SDKs
    - LLMService includes deterministic offline provider
    - DBService uses in-memory mock provider
    - TTSService supports browser fallback
    - safety/output/memory/RAG can still run locally

    Production provider adapters should be wired here later.
    """
    settings = get_settings()

    llm = LLMService(settings=settings)

    auth = AuthService(settings=settings)
    db = DBService(settings=settings)

    memory = MemoryService(settings=settings, llm_service=llm)
    output_guard = OutputGuardService(llm_service=llm)
    rag = RAGService(llm_service=llm)
    safety = SafetyService(llm_service=llm)
    tts = TTSService(settings=settings)

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
    """
    Clear singleton container.

    Use only in tests when monkeypatching settings or provider adapters.
    """
    get_service_container.cache_clear()


def get_services() -> ServiceContainer:
    return get_service_container()


ServicesDep = Annotated[ServiceContainer, Depends(get_services)]


def get_request_id(
    x_request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> str:
    cleaned = sanitize_text(str(x_request_id or ""), MAX_REQUEST_ID_HEADER_CHARS)

    if cleaned:
        return cleaned

    return generate_request_id()


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

    # Accept-Language may look like "ar-EG,ar;q=0.9,en;q=0.8".
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
    cleaned = sanitize_text(str(x_mindpal_user_id or "anonymous"), MAX_ANONYMOUS_USER_HEADER_CHARS)
    return cleaned or "anonymous"


async def get_current_session(
    services: ServicesDep,
    locale: Annotated[str, Depends(get_locale)],
    channel: Annotated[UserChannel, Depends(get_channel)],
    anonymous_user_id: Annotated[str, Depends(get_anonymous_user_id)],
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> UserSession:
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
    """
    Build sanitized request context and attach request id to request.state.
    """
    request.state.request_id = request_id
    request.state.locale = locale
    request.state.channel = channel.value
    request.state.user_id_hash = session.user_id_hash

    return RequestContext(
        request_id=request_id,
        locale=locale,
        channel=channel,
        session=session,
    )


RequestContextDep = Annotated[RequestContext, Depends(get_request_context)]