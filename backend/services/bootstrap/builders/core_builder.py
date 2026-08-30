"""
Core service builders (Auth, DB, LLM, TTS).

These are the foundational services that everything else depends on.
"""

import httpx

from backend.core.config import Settings
from backend.providers import build_llm_providers, build_tts_providers
from backend.services import AuthService, DBService, LLMService, LLMServiceConfig, TTSService, TTSServiceConfig


def build_auth_service(settings: Settings) -> AuthService:
    """
    Construct auth service with configured provider.

    Args:
        settings: Application settings

    Returns:
        AuthService instance
    """
    return AuthService(
        settings=settings,
        allow_anonymous=settings.ALLOW_ANONYMOUS_SESSIONS,
    )


def build_db_service(settings: Settings) -> DBService:
    """
    Construct database service.

    Args:
        settings: Application settings

    Returns:
        DBService instance
    """
    return DBService(settings=settings)


def build_llm_service(settings: Settings, http_client: httpx.AsyncClient) -> LLMService:
    """
    Construct LLM service with configured providers.

    Args:
        settings: Application settings
        http_client: Shared HTTP client

    Returns:
        LLMService instance with all configured providers
    """
    llm_providers = build_llm_providers(settings, client=http_client)

    return LLMService(
        providers=llm_providers,
        settings=settings,
        config=LLMServiceConfig.from_settings(
            settings,
            include_offline_provider=settings.ENABLE_OFFLINE_LLM_FALLBACK or not settings.has_any_llm_provider,
        ),
    )


def build_tts_service(settings: Settings, http_client: httpx.AsyncClient) -> TTSService:
    """
    Construct TTS service with configured providers.

    Args:
        settings: Application settings
        http_client: Shared HTTP client

    Returns:
        TTSService instance with all configured providers
    """
    tts_providers = build_tts_providers(settings, client=http_client)

    return TTSService(
        providers=tts_providers,
        settings=settings,
        config=TTSServiceConfig.from_settings(
            settings,
            include_browser_fallback=settings.ENABLE_BROWSER_TTS_FALLBACK,
        ),
    )
