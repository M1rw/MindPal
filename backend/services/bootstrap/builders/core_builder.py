"""
Core service builders (Auth, DB, LLM, TTS).

These are the foundational services that everything else depends on.
"""

import httpx

from backend.core.config import Settings
from backend.providers import build_auth_provider, build_llm_providers, build_tts_providers
from backend.services.domain.auth import AuthService, FirebaseAuthProvider, OfflineAuthProvider
from backend.services.domain.storage import StorageService as DBService
from backend.services.domain.llm import LLMService
from backend.services.domain.voice import TTSService
from backend.services.configs import LLMServiceConfig, TTSServiceConfig


def build_auth_service(settings: Settings) -> AuthService:
    """
    Construct auth service with configured provider.

    Args:
        settings: Application settings

    Returns:
        AuthService instance
    """
    provider = build_auth_provider(settings)
    if provider is None or not getattr(provider, "is_configured", False):
        if bool(getattr(settings, "OFFLINE_MODE", False)):
            provider = OfflineAuthProvider()
        else:
            firebase_provider = FirebaseAuthProvider(settings=settings)
            provider = firebase_provider if firebase_provider.is_configured else OfflineAuthProvider()

    return AuthService(
        provider=provider,
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
