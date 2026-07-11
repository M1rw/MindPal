# backend/providers/__init__.py

"""
MindPal provider adapters.

This package contains optional external provider adapters. Importing this
package must not:
- call any external network
- initialize Firebase apps
- verify auth tokens
- read/write Firestore
- synthesize audio
- call LLM APIs

Provider instances may be constructed safely, but external calls only happen
when service methods are invoked.
"""

from __future__ import annotations

from collections.abc import Sequence

import httpx

from backend.core.config import Settings, get_settings
from backend.core.security import sanitize_text
from backend.services.auth_service import AuthProvider
from backend.services.db_service import DBProvider
from backend.services.llm_service import LLMProvider
from backend.services.tts_service import TTSProvider

from .camb_provider import CambProvider, CambProviderConfig
from .firebase_provider import FirebaseProvider, FirebaseProviderConfig
from .gemini_provider import GeminiProvider, GeminiProviderConfig
from .cloudflare_provider import CloudflareAIProvider, CloudflareAIProviderConfig
from .groq_provider import GroqProvider, GroqProviderConfig
from .openrouter_provider import OpenRouterProvider, OpenRouterProviderConfig


DEFAULT_LLM_PROVIDER_ORDER: tuple[str, ...] = ("cloudflare", "gemini", "openrouter", "groq")
DEFAULT_TTS_PROVIDER_ORDER: tuple[str, ...] = ("camb",)


def build_llm_providers(
    settings: Settings | None = None,
    *,
    order: Sequence[str] | None = None,
    include_unconfigured: bool = False,
    client: httpx.AsyncClient | None = None,
) -> list[LLMProvider]:
    """
    Build configured LLM providers in deterministic priority order.

    Offline fallback is intentionally not included here. LLMService owns the
    deterministic OfflineLLMProvider fallback.
    """
    settings = settings or get_settings()
    provider_order = _provider_order(
        order=order,
        settings_value=getattr(settings, "LLM_PROVIDER_ORDER", None),
        default=DEFAULT_LLM_PROVIDER_ORDER,
    )

    registry: dict[str, LLMProvider] = {
        "gemini": GeminiProvider(GeminiProviderConfig.from_settings(settings), client=client),
        "cloudflare": CloudflareAIProvider(CloudflareAIProviderConfig.from_settings(settings), client=client),
        "openrouter": OpenRouterProvider(OpenRouterProviderConfig.from_settings(settings), client=client),
        "groq": GroqProvider(GroqProviderConfig.from_settings(settings), client=client),
    }

    return _ordered_configured(
        registry=registry,
        order=provider_order,
        include_unconfigured=include_unconfigured,
    )


def build_tts_providers(
    settings: Settings | None = None,
    *,
    order: Sequence[str] | None = None,
    include_unconfigured: bool = False,
    client: httpx.AsyncClient | None = None,
) -> list[TTSProvider]:
    """
    Build configured external TTS providers.

    Browser fallback is intentionally not included here. TTSService owns the
    BrowserFallbackTTSProvider fallback.
    """
    settings = settings or get_settings()
    provider_order = _provider_order(
        order=order,
        settings_value=getattr(settings, "TTS_PROVIDER_ORDER", None),
        default=DEFAULT_TTS_PROVIDER_ORDER,
    )

    registry: dict[str, TTSProvider] = {
        "camb": CambProvider(CambProviderConfig.from_settings(settings), client=client),
    }

    return _ordered_configured(
        registry=registry,
        order=provider_order,
        include_unconfigured=include_unconfigured,
    )


def build_firebase_provider(
    settings: Settings | None = None,
    *,
    include_unconfigured: bool = False,
) -> FirebaseProvider | None:
    """
    Build Firebase provider if configured.

    The returned provider implements both AuthProvider and DBProvider.
    """
    settings = settings or get_settings()
    provider = FirebaseProvider(FirebaseProviderConfig.from_settings(settings))

    if provider.is_configured or include_unconfigured:
        return provider

    return None


def build_auth_provider(
    settings: Settings | None = None,
    *,
    include_unconfigured: bool = False,
) -> AuthProvider | None:
    return build_firebase_provider(
        settings,
        include_unconfigured=include_unconfigured,
    )


def build_db_provider(
    settings: Settings | None = None,
    *,
    include_unconfigured: bool = False,
) -> DBProvider | None:
    return build_firebase_provider(
        settings,
        include_unconfigured=include_unconfigured,
    )


def _provider_order(
    *,
    order: Sequence[str] | None,
    settings_value: object,
    default: tuple[str, ...],
) -> tuple[str, ...]:
    if order is not None:
        return _clean_provider_order(order, default=default)

    if isinstance(settings_value, str) and settings_value.strip():
        return _clean_provider_order(settings_value.split(","), default=default)

    if isinstance(settings_value, Sequence) and not isinstance(settings_value, (str, bytes, bytearray)):
        return _clean_provider_order(settings_value, default=default)

    return default


def _clean_provider_order(
    values: Sequence[object],
    *,
    default: tuple[str, ...],
) -> tuple[str, ...]:
    cleaned: list[str] = []
    seen: set[str] = set()

    for value in values:
        item = sanitize_text(str(value or ""), 80).lower()

        if not item or item in seen:
            continue

        seen.add(item)
        cleaned.append(item)

    return tuple(cleaned) or default


def _ordered_configured(
    *,
    registry: dict[str, object],
    order: tuple[str, ...],
    include_unconfigured: bool,
) -> list:
    providers: list = []
    seen: set[str] = set()

    for name in order:
        provider = registry.get(name)

        if provider is None:
            continue

        seen.add(name)

        is_configured = bool(getattr(provider, "is_configured", False))
        if is_configured or include_unconfigured:
            providers.append(provider)

    for name, provider in registry.items():
        if name in seen:
            continue

        is_configured = bool(getattr(provider, "is_configured", False))
        if is_configured or include_unconfigured:
            providers.append(provider)

    return providers


__all__ = [
    "CloudflareAIProviderConfig",
    "CloudflareAIProvider",
    "CambProvider",
    "CambProviderConfig",
    "DEFAULT_LLM_PROVIDER_ORDER",
    "DEFAULT_TTS_PROVIDER_ORDER",
    "FirebaseProvider",
    "FirebaseProviderConfig",
    "GeminiProvider",
    "GeminiProviderConfig",
    "GroqProvider",
    "GroqProviderConfig",
    "OpenRouterProvider",
    "OpenRouterProviderConfig",
    "build_auth_provider",
    "build_db_provider",
    "build_firebase_provider",
    "build_llm_providers",
    "build_tts_providers",
]