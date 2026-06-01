# backend/services/llm_service.py

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from time import perf_counter
from typing import Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.models.chat import LLMMessage, LLMRequest, LLMResponse, LLMRole
from backend.models.schemas import ProviderCallTrace, ProviderChainTrace


MAX_PROVIDER_NAME_CHARS = 80
MAX_PROVIDER_ERROR_CHARS = 120
MAX_OFFLINE_REPLY_CHARS = 1_500


class LLMProvider(Protocol):
    """
    Provider protocol used by LLMService.

    Future provider classes in backend/providers must implement this interface.
    The service intentionally does not import provider modules to avoid cycles.
    """

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def generate(self, request: LLMRequest) -> LLMResponse:
        ...


@dataclass(frozen=True, slots=True)
class LLMServiceResult:
    response: LLMResponse
    trace: ProviderChainTrace


class OfflineLLMProvider:
    """
    Deterministic local fallback provider.

    This is not a clinical model. It exists so chat can degrade safely when all
    remote LLM providers are unavailable, missing keys, or timing out.
    """

    name = "offline"

    @property
    def is_configured(self) -> bool:
        return True

    async def generate(self, request: LLMRequest) -> LLMResponse:
        latest_user_message = _latest_user_message(request.messages)
        text = self._build_offline_reply(latest_user_message)

        return LLMResponse(
            text=text,
            provider_used=self.name,
            fallback_count=0,
            latency_ms=0.0,
            model_name="deterministic_offline_v1",
            finish_reason="offline_fallback",
        )

    def _build_offline_reply(self, latest_user_message: str) -> str:
        lowered = latest_user_message.lower()

        if _contains_any(
            lowered,
            (
                "panic",
                "can't breathe",
                "cannot breathe",
                "heart racing",
                "panicking",
                "نوبة هلع",
                "مش قادر اتنفس",
                "مش قادرة اتنفس",
                "قلبي",
            ),
        ):
            return (
                "Let’s slow this down with one safe step. Put both feet on the ground, "
                "look around, and name 5 things you can see. Then take one slow breath in "
                "and one slow breath out. Reply with the 5 things you see."
            )

        if _contains_any(
            lowered,
            (
                "kill myself",
                "end my life",
                "suicide",
                "hurt myself",
                "harm myself",
                "هنتحر",
                "هقتل نفسي",
                "اؤذي نفسي",
                "أؤذي نفسي",
            ),
        ):
            return (
                "If you might act on this now, contact local emergency services now or go "
                "to the nearest emergency department. Move away from anything you could use "
                "to hurt yourself, and contact someone nearby with: “I’m not safe alone right now.”"
            )

        if _contains_any(
            lowered,
            (
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
            ),
        ):
            return (
                "I’m here with you. Pick one small next step: drink water, sit somewhere "
                "stable, or write one sentence: “Right now I feel ___ because ___.” "
                "Start with the sentence."
            )

        return (
            "I can support you with one grounded wellness step. Tell me what you are "
            "feeling right now in one sentence, and I’ll help you choose the next safe step."
        )


class LLMService:
    """
    Provider fallback orchestrator.

    Responsibilities:
    - skip unconfigured providers
    - apply per-provider timeout
    - cascade failures safely
    - return deterministic offline fallback if all remote providers fail
    - expose provider trace metadata without raw prompt contents

    Non-responsibilities:
    - safety classification
    - output guard
    - RAG retrieval
    - memory compaction

    Required chat route order:
    safety_service.classify_input()
    -> maybe deterministic crisis response
    -> RAG/memory prompt construction
    -> llm_service.generate()
    -> output_guard_service.validate_output()
    """

    def __init__(
        self,
        providers: Sequence[LLMProvider] | None = None,
        *,
        settings: Settings | None = None,
        timeout_seconds: float | None = None,
        include_offline_provider: bool = True,
    ) -> None:
        self.settings = settings or get_settings()
        self.timeout_seconds = float(timeout_seconds or self.settings.LLM_TIMEOUT_SECONDS)

        configured_providers: list[LLMProvider] = list(providers or [])

        if include_offline_provider and not _has_provider(configured_providers, "offline"):
            configured_providers.append(OfflineLLMProvider())

        if not configured_providers:
            raise ProviderError(
                "LLMService requires at least one provider",
                code="llm_no_providers",
            )

        self._providers = configured_providers

    @property
    def providers(self) -> tuple[LLMProvider, ...]:
        return tuple(self._providers)

    def register_provider(self, provider: LLMProvider, *, replace: bool = False) -> None:
        provider_name = _clean_provider_name(provider.name)

        existing_index = next(
            (
                index
                for index, current_provider in enumerate(self._providers)
                if _clean_provider_name(current_provider.name) == provider_name
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
        result = await self.generate_with_trace(request)
        return result.response

    async def generate_with_trace(self, request: LLMRequest) -> LLMServiceResult:
        traces: list[ProviderCallTrace] = []
        fallback_count = 0

        for provider in self._providers:
            provider_name = _clean_provider_name(provider.name)

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

            started = perf_counter()

            try:
                provider_response = await asyncio.wait_for(
                    provider.generate(request),
                    timeout=self.timeout_seconds,
                )

                latency_ms = _elapsed_ms(started)

                response = _normalize_provider_response(
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
                    fallback_count=_clamp_fallback_count(fallback_count),
                    calls=traces,
                )

                return LLMServiceResult(response=response, trace=trace)

            except asyncio.TimeoutError as exc:
                latency_ms = _elapsed_ms(started)
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

                if _is_last_provider(provider, self._providers):
                    raise ProviderTimeoutError(
                        "All LLM providers timed out",
                        code="llm_all_providers_timeout",
                        details={"last_provider": provider_name},
                    ) from exc

                continue

            except ProviderError as exc:
                latency_ms = _elapsed_ms(started)
                traces.append(
                    ProviderCallTrace(
                        provider=provider_name,
                        attempted=True,
                        succeeded=False,
                        latency_ms=latency_ms,
                        error_code=_clean_error_code(exc.code),
                    )
                )
                fallback_count += 1
                continue

            except asyncio.CancelledError:
                raise

            except Exception:
                latency_ms = _elapsed_ms(started)
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
            "All LLM providers failed",
            code="llm_all_providers_failed",
            details={
                "providers_attempted": ",".join(
                    trace.provider for trace in traces if trace.attempted
                ),
                "providers_skipped": ",".join(
                    trace.provider for trace in traces if trace.skipped
                ),
            },
        )

    def health(self) -> dict[str, object]:
        return {
            "providers": [
                {
                    "name": _clean_provider_name(provider.name),
                    "configured": bool(provider.is_configured),
                }
                for provider in self._providers
            ],
            "timeout_seconds": self.timeout_seconds,
            "offline_available": any(
                _clean_provider_name(provider.name) == "offline"
                for provider in self._providers
            ),
        }


def build_llm_request(
    *,
    request_id: str,
    system_prompt: str,
    user_message: str,
    history: Sequence[LLMMessage] | None = None,
    temperature: float = 0.4,
    max_output_tokens: int = 700,
    metadata: dict[str, str | int | float | bool | None] | None = None,
) -> LLMRequest:
    """
    Build an LLMRequest with a guaranteed system message.

    `history` must already be sanitized domain messages if passed from routers.
    """
    messages: list[LLMMessage] = [
        LLMMessage(role=LLMRole.SYSTEM, content=system_prompt),
    ]

    if history:
        messages.extend(history)

    messages.append(
        LLMMessage(
            role=LLMRole.USER,
            content=user_message,
        )
    )

    return LLMRequest(
        request_id=request_id,
        messages=messages,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        metadata=metadata or {},
    )


def _normalize_provider_response(
    response: LLMResponse,
    *,
    provider_name: str,
    fallback_count: int,
    latency_ms: float,
) -> LLMResponse:
    return LLMResponse(
        text=response.text,
        provider_used=response.provider_used or provider_name,
        fallback_count=_clamp_fallback_count(fallback_count),
        latency_ms=latency_ms,
        model_name=response.model_name,
        finish_reason=response.finish_reason,
    )


def _latest_user_message(messages: Sequence[LLMMessage]) -> str:
    for message in reversed(messages):
        if message.role == LLMRole.USER:
            return sanitize_text(message.content, MAX_OFFLINE_REPLY_CHARS)

    return ""


def _contains_any(text: str, needles: Sequence[str]) -> bool:
    return any(needle.lower() in text for needle in needles)


def _has_provider(providers: Sequence[LLMProvider], provider_name: str) -> bool:
    clean_target = _clean_provider_name(provider_name)
    return any(_clean_provider_name(provider.name) == clean_target for provider in providers)


def _is_last_provider(provider: LLMProvider, providers: Sequence[LLMProvider]) -> bool:
    return provider is providers[-1]


def _clean_provider_name(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
    return cleaned or "unknown"


def _clean_error_code(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_ERROR_CHARS)
    return cleaned or "provider_error"


def _elapsed_ms(started: float) -> float:
    return round((perf_counter() - started) * 1000, 3)


def _clamp_fallback_count(value: int) -> int:
    return max(0, min(int(value), 10))