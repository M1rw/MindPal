# backend/services/domain/llm/service.py

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Final

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.core.settings_helpers import is_production
from backend.models.chat import LLMMessage, LLMRequest, LLMResponse, LLMRole
from backend.models.schemas import ProviderCallTrace, ProviderChainTrace
from backend.services.configs import LLMServiceConfig
from backend.services.core.circuit_breaker import circuit_open as _circuit_open
from backend.services.core.circuit_breaker import trip_circuit as _trip_circuit
from backend.services.domain.llm.protocols import LLMProvider
from backend.services.domain.llm.response_parser import (
    clamp_fallback_count,
    clean_provider_name,
    normalize_provider_response,
)

logger = logging.getLogger(__name__)

DEFAULT_LLM_SERVICE_CONFIG: Final[LLMServiceConfig] = LLMServiceConfig()
MAX_PROVIDER_ERROR_CHARS: Final[int] = DEFAULT_LLM_SERVICE_CONFIG.max_provider_error_chars
MAX_OFFLINE_REPLY_CHARS: Final[int] = DEFAULT_LLM_SERVICE_CONFIG.max_offline_reply_chars

# Safety keyword sets for deterministic local offline response generator
PANIC_KEYWORDS: Final[tuple[str, ...]] = (
    "panic",
    "can't breathe",
    "cannot breathe",
    "heart racing",
    "panicking",
    "نوبة هلع",
    "مش قادر اتنفس",
    "مش قادرة اتنفس",
    "قلبي",
)

SUICIDE_KEYWORDS: Final[tuple[str, ...]] = (
    "kill myself",
    "end my life",
    "suicide",
    "hurt myself",
    "harm myself",
    "هنتحر",
    "هقتل نفسي",
    "اؤذي نفسي",
    "أؤذي نفسي",
)

DISTRESS_KEYWORDS: Final[tuple[str, ...]] = (
    "anxious",
    "anxiety",
    "overwhelmed",
    "stressed",
    "sad",
    "hopeless",
    "قلقان",
    "قلقانة",
    "مضغوط",
    "مضغوطة",
    "حزين",
    "حزينة",
)


@dataclass(frozen=True, slots=True)
class LLMServiceResult:
    """Encapsulates the final LLM response alongside the execution chain trace."""

    response: LLMResponse
    trace: ProviderChainTrace


class OfflineLLMProvider:
    """
    Deterministic local fallback provider for resilient offline operation.
    """

    __slots__ = ()

    name: Final[str] = "offline"

    @property
    def is_configured(self) -> bool:
        """Offline provider is always configured as a local fallback."""
        return True

    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate a safety-focused deterministic response offline."""
        latest_user_message = self._extract_latest_user_message(request.messages)
        text = self._build_offline_reply(latest_user_message)

        return LLMResponse(
            text=text,
            provider_used=self.name,
            fallback_count=0,
            latency_ms=0.0,
            model_name="offline-deterministic",
            finish_reason="stop",
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncIterator[str]:
        """Stream the offline response as a single text chunk."""
        res = await self.generate(request)
        yield res.text

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return zeroed fallback embeddings for offline vector generation."""
        return [[0.0] * 768 for _ in texts]

    def _extract_latest_user_message(self, messages: Sequence[LLMMessage]) -> str:
        """Extract and sanitize the most recent user message from context history."""
        for message in reversed(messages):
            if message.role == LLMRole.USER:
                return sanitize_text(message.content, MAX_OFFLINE_REPLY_CHARS)
        return ""

    def _build_offline_reply(self, latest_user_message: str) -> str:
        """Classify message intent and build tailored grounding reply."""
        lowered = latest_user_message.lower()

        if self._contains_any(lowered, PANIC_KEYWORDS):
            return (
                "Let’s slow this down with one safe step. Put both feet on the ground, "
                "look around, and name 5 things you can see. Then take one slow breath in "
                "and one slow breath out. Reply with the 5 things you see."
            )

        if self._contains_any(lowered, SUICIDE_KEYWORDS):
            return (
                "If you might act on this now, contact local emergency services now or go "
                "to the nearest emergency department. Move away from anything you could use "
                "to hurt yourself, and contact someone nearby with: “I’m not safe alone right now.”"
            )

        if self._contains_any(lowered, DISTRESS_KEYWORDS):
            return (
                "I’m here with you. Pick one small next step: drink water, sit somewhere "
                "stable, or write one sentence: “Right now I feel ___ because ___.” "
                "Start with the sentence."
            )

        return (
            "I can support you with one grounded wellness step. Tell me what you are "
            "feeling right now in one sentence, and I’ll help you choose the next safe step."
        )

    @staticmethod
    def _contains_any(text: str, needles: Sequence[str]) -> bool:
        return any(needle.lower() in text for needle in needles)


class LLMService:
    """
    Orchestrates LLM provider invocation, fallback execution, circuit breaking, and trace logging.
    """

    def __init__(
        self,
        providers: Sequence[LLMProvider] | None = None,
        *,
        settings: Settings | None = None,
        config: LLMServiceConfig | None = None,
        timeout_seconds: float | None = None,
        include_offline_provider: bool | None = None,
        require_remote_provider: bool | None = None,
        allow_offline_in_production: bool | None = None,
    ) -> None:
        self.settings: Settings = settings or get_settings()
        self.config: LLMServiceConfig = config or LLMServiceConfig.from_settings(self.settings)
        self._trace_cache: dict[str, ProviderChainTrace] = {}
        self._trace_ids: deque[str] = deque(maxlen=200)
        self.production_mode: bool = is_production(self.settings)

        self.timeout_seconds: float = float(
            timeout_seconds if timeout_seconds is not None else self.config.timeout_seconds
        )
        self.require_remote_provider: bool = (
            bool(require_remote_provider)
            if require_remote_provider is not None
            else self.config.require_remote_provider
        )
        self.allow_offline_in_production: bool = (
            bool(allow_offline_in_production)
            if allow_offline_in_production is not None
            else self.config.allow_offline_in_production
        )

        should_include_offline = (
            bool(include_offline_provider)
            if include_offline_provider is not None
            else self.config.include_offline_provider
        )

        configured_providers: list[LLMProvider] = list(providers or [])

        if should_include_offline and not self._has_provider(configured_providers, "offline"):
            configured_providers.append(OfflineLLMProvider())

        if not configured_providers:
            raise ProviderError(
                "LLMService requires at least one provider",
                code="llm_no_providers",
            )

        self._providers: list[LLMProvider] = configured_providers

        if self.require_remote_provider and not self._has_configured_remote_provider():
            if not self._offline_allowed_for_current_environment():
                raise ProviderError(
                    "Production requires at least one configured remote LLM provider",
                    code="llm_remote_provider_required",
                )

    @property
    def providers(self) -> tuple[LLMProvider, ...]:
        """Return registered provider instances as an immutable tuple."""
        return tuple(self._providers)

    def register_provider(self, provider: LLMProvider, *, replace: bool = False) -> None:
        """
        Register a new LLM provider instance into the fallback pipeline.
        """
        provider_name = clean_provider_name(provider.name)

        existing_index = next(
            (
                index
                for index, current_provider in enumerate(self._providers)
                if clean_provider_name(current_provider.name) == provider_name
            ),
            None,
        )

        if existing_index is not None:
            if not replace:
                raise ProviderError(
                    "Provider already registered",
                    code="llm_provider_duplicate",
                    details={"provider": provider_name},
                )

            self._providers[existing_index] = provider
            return

        self._providers.append(provider)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        """
        Generate text completion with full provider fallback chain.
        """
        result = await self.generate_with_trace(request)
        return result.response

    async def generate_stream(self, request: LLMRequest) -> Any:
        """
        Stream text completion chunks from the first responsive provider in fallback hierarchy.
        """
        fallback_count = 0
        attempted_remote = False

        for provider in self._providers:
            provider_name = clean_provider_name(provider.name)
            is_offline = provider_name == "offline"

            if is_offline and not self._offline_allowed_for_current_environment():
                fallback_count += 1
                continue

            if is_offline and self.require_remote_provider and not attempted_remote:
                fallback_count += 1
                continue

            if not provider.is_configured:
                fallback_count += 1
                continue

            if _circuit_open(provider_name):
                fallback_count += 1
                continue

            if not is_offline:
                attempted_remote = True

            has_yielded = False
            try:
                stream_generator = provider.generate_stream(request)

                if hasattr(stream_generator, "__aiter__"):
                    iterator = stream_generator.__aiter__()

                    try:
                        first_chunk = await asyncio.wait_for(
                            iterator.__anext__(),
                            timeout=self.timeout_seconds,
                        )
                        yield first_chunk
                        has_yielded = True

                        async for chunk in iterator:
                            yield chunk

                        return

                    except StopAsyncIteration:
                        return

            except asyncio.CancelledError:
                raise
            except TimeoutError:
                if has_yielded:
                    raise
                fallback_count += 1
                if provider is self._providers[-1]:
                    raise ProviderTimeoutError(
                        "All enabled LLM providers timed out",
                        code="llm_all_providers_timeout",
                    )
                continue
            except ProviderError as exc:
                if has_yielded:
                    raise
                details = getattr(exc, "details", None) or {}
                status_str = str(details.get("status_code", ""))
                if status_str in ("429", "402"):
                    _trip_circuit(provider_name)
                fallback_count += 1
                continue
            except Exception:
                logger.warning("Provider %s raised unexpected error during stream", provider_name, exc_info=True)
                if has_yielded:
                    raise
                fallback_count += 1
                continue

        raise ProviderError(
            "All enabled LLM providers failed to stream",
            code="llm_all_providers_failed",
        )

    async def generate_with_trace(self, request: LLMRequest) -> LLMServiceResult:
        """
        Execute request generation through provider fallback chain while logging execution telemetry.
        """
        traces: list[ProviderCallTrace] = []
        fallback_count = 0
        attempted_remote = False

        for provider in self._providers:
            provider_name = clean_provider_name(provider.name)
            is_offline = provider_name == "offline"

            if is_offline and not self._offline_allowed_for_current_environment():
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        skipped=True,
                        error_code="offline_fallback_disabled",
                    )
                )
                fallback_count += 1
                continue

            if is_offline and self.require_remote_provider and not attempted_remote:
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        skipped=True,
                        error_code="remote_provider_required_before_offline",
                    )
                )
                fallback_count += 1
                continue

            if not provider.is_configured:
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        skipped=True,
                        error_code="provider_not_configured",
                    )
                )
                fallback_count += 1
                continue

            if _circuit_open(provider_name):
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        skipped=True,
                        error_code="circuit_breaker_open",
                    )
                )
                fallback_count += 1
                continue

            if not is_offline:
                attempted_remote = True

            started = perf_counter()

            try:
                provider_response = await asyncio.wait_for(
                    provider.generate(request),
                    timeout=self.timeout_seconds,
                )

                latency_ms = round((perf_counter() - started) * 1000, 3)

                response = normalize_provider_response(
                    provider_response,
                    provider_name=provider_name,
                    fallback_count=fallback_count,
                    latency_ms=latency_ms,
                )

                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        attempted=True,
                        succeeded=True,
                        latency_ms=latency_ms,
                    )
                )

                trace = ProviderChainTrace(
                    request_id=request.request_id,
                    provider_used=response.provider_used,
                    fallback_count=clamp_fallback_count(fallback_count),
                    user_id_hash=sanitize_text(str(request.metadata.get("user_id_hash") or ""), 120) or None,
                    calls=traces,
                )

                self._cache_trace(trace)

                return LLMServiceResult(response=response, trace=trace)

            except asyncio.CancelledError:
                raise

            except TimeoutError as exc:
                latency_ms = round((perf_counter() - started) * 1000, 3)
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        attempted=True,
                        succeeded=False,
                        latency_ms=latency_ms,
                        error_code="provider_timeout",
                    )
                )
                fallback_count += 1

                if provider is self._providers[-1]:
                    raise ProviderTimeoutError(
                        "All enabled LLM providers timed out",
                        code="llm_all_providers_timeout",
                        details={"last_provider": provider_name},
                    ) from exc

                continue

            except ProviderError as exc:
                latency_ms = round((perf_counter() - started) * 1000, 3)
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        attempted=True,
                        succeeded=False,
                        latency_ms=latency_ms,
                        error_code=sanitize_text(str(exc.code or ""), MAX_PROVIDER_ERROR_CHARS) or "provider_error",
                    )
                )
                details = exc.details or {}
                status_str = str(details.get("status_code", ""))
                if status_str in ("429", "402"):
                    _trip_circuit(provider_name)
                fallback_count += 1
                continue

            except Exception:
                logger.warning("Provider %s raised unexpected error", provider_name, exc_info=True)
                latency_ms = round((perf_counter() - started) * 1000, 3)
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        attempted=True,
                        succeeded=False,
                        latency_ms=latency_ms,
                        error_code="provider_unhandled_error",
                    )
                )
                fallback_count += 1
                continue

        raise ProviderError(
            "All enabled LLM providers failed",
            code="llm_all_providers_failed",
            details={
                "providers_attempted": ",".join(trace.provider for trace in traces if trace.attempted),
                "providers_skipped": ",".join(trace.provider for trace in traces if trace.skipped),
                "remote_provider_required": str(self.require_remote_provider),
                "offline_allowed": str(self._offline_allowed_for_current_environment()),
            },
        )

    def health(self) -> dict[str, object]:
        """
        Return diagnostic health and status metrics for all registered providers.
        """
        providers = [
            {
                "name": clean_provider_name(provider.name),
                "configured": bool(provider.is_configured),
                "offline": clean_provider_name(provider.name) == "offline",
            }
            for provider in self._providers
        ]

        remote_provider_available = any(item["configured"] and not item["offline"] for item in providers)
        offline_available = any(item["configured"] and item["offline"] for item in providers)

        return {
            "providers": providers,
            "timeout_seconds": self.timeout_seconds,
            "production_mode": self.production_mode,
            "remote_provider_available": remote_provider_available,
            "configured_remote_provider_available": remote_provider_available,
            "require_remote_provider": self.require_remote_provider,
            "offline_available": offline_available,
            "offline_enabled": self._has_provider(self._providers, "offline"),
            "offline_allowed": self._offline_allowed_for_current_environment(),
            "allow_offline_in_production": self.allow_offline_in_production,
        }

    def _has_configured_remote_provider(self) -> bool:
        return any(
            clean_provider_name(provider.name) != "offline" and bool(provider.is_configured)
            for provider in self._providers
        )

    def get_trace(self, request_id: str) -> ProviderChainTrace | None:
        """Retrieve stored execution chain trace for a request ID."""
        return self._trace_cache.get(request_id)

    def _cache_trace(self, trace: ProviderChainTrace) -> None:
        if not trace.request_id or trace.request_id in self._trace_cache:
            return
        if len(self._trace_ids) >= self._trace_ids.maxlen:
            oldest = self._trace_ids.popleft()
            self._trace_cache.pop(oldest, None)
        self._trace_ids.append(trace.request_id)
        self._trace_cache[trace.request_id] = trace

    def _offline_allowed_for_current_environment(self) -> bool:
        if not self._has_provider(self._providers, "offline"):
            return False
        if self.production_mode:
            return self.allow_offline_in_production
        return True

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """
        Delegate vector embedding calculation to the primary configured provider.
        """
        if not texts:
            return []

        provider = next(
            (p for p in self._providers if p.is_configured and clean_provider_name(p.name) != "offline"),
            None,
        )

        if not provider:
            provider = next(
                (p for p in self._providers if p.is_configured and clean_provider_name(p.name) == "offline"),
                None,
            )

        if not provider:
            raise ProviderError(
                "No configured provider available for embedding",
                code="llm_no_provider",
            )

        return await provider.embed(texts)

    @staticmethod
    def _has_provider(providers: Sequence[LLMProvider], provider_name: str) -> bool:
        clean_target = clean_provider_name(provider_name)
        return any(clean_provider_name(provider.name) == clean_target for provider in providers)
