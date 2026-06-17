# backend/providers/openrouter_provider.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.models.chat import LLMRequest, LLMResponse
from backend.providers._shared import (
    build_provider_http_error,
    clean_error,
    convert_openai_messages,
    extract_openai_finish_reason,
    extract_openai_metadata,
    extract_openai_model,
    extract_openai_text,
    iter_sse_text,
    sanitize_jsonish,
    setting_secret,
)


DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"
DEFAULT_TIMEOUT_SECONDS = 45.0

MAX_MODEL_NAME_CHARS = 160
MAX_HEADER_VALUE_CHARS = 300
MAX_TEXT_CHARS = 80_000


@dataclass(frozen=True, slots=True)
class OpenRouterProviderConfig:
    api_key: str
    model: str = DEFAULT_OPENROUTER_MODEL
    base_url: str = DEFAULT_OPENROUTER_BASE_URL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    app_url: str | None = None
    app_title: str | None = None

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> OpenRouterProviderConfig:
        settings = settings or get_settings()

        return cls(
            api_key=sanitize_text(setting_secret(settings, "OPENROUTER_API_KEY"), 4_000),
            model=sanitize_text(
                str(
                    getattr(settings, "OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
                    or DEFAULT_OPENROUTER_MODEL
                ),
                MAX_MODEL_NAME_CHARS,
            ),
            base_url=sanitize_text(
                str(
                    getattr(settings, "OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL)
                    or DEFAULT_OPENROUTER_BASE_URL
                ),
                300,
            ).rstrip("/"),
            timeout_seconds=float(
                getattr(settings, "OPENROUTER_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
                or DEFAULT_TIMEOUT_SECONDS
            ),
            app_url=_optional_header_value(
                getattr(settings, "APP_URL", None)
                or getattr(settings, "OPENROUTER_APP_URL", None)
            ),
            app_title=_optional_header_value(
                getattr(settings, "APP_NAME", None)
                or getattr(settings, "OPENROUTER_APP_TITLE", None)
                or "MindPal"
            ),
        )


class OpenRouterProvider:
    """
    OpenRouter chat-completions provider for LLMService.

    Safety boundary:
    - no network call at import
    - no OpenAI SDK import required
    - API key is sent in Authorization header only
    - provider errors are redacted before surfacing
    - raw HTTP payload is not exposed in exceptions
    """

    name = "openrouter"

    def __init__(
        self,
        config: OpenRouterProviderConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or OpenRouterProviderConfig.from_settings()
        self._client = client

    @property
    def is_configured(self) -> bool:
        return bool(self.config.api_key)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        if not self.is_configured:
            raise ProviderError(
                "OpenRouter provider is not configured",
                code="openrouter_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        headers = self._build_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.post(
                self._chat_completions_url(),
                headers=headers,
                json=payload,
            )

            if response.status_code >= 400:
                raise build_provider_http_error(response, provider_name="openrouter")

            data = response.json()
            text = extract_openai_text(data, MAX_TEXT_CHARS)

            if not text:
                raise ProviderError(
                    "OpenRouter returned an empty response",
                    code="openrouter_empty_response",
                    details=extract_openai_metadata(data),
                )

            return LLMResponse(
                text=text,
                provider_used=self.name,
                fallback_count=0,
                latency_ms=0.0,
                model_name=extract_openai_model(data, self.config.model),
                finish_reason=extract_openai_finish_reason(data),
            )

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "OpenRouter request timed out",
                code="openrouter_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "OpenRouter HTTP request failed",
                code="openrouter_http_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        except ValueError as exc:
            raise ProviderError(
                "OpenRouter response was not valid JSON",
                code="openrouter_invalid_json",
                details={"provider": self.name},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    async def generate_stream(self, request: LLMRequest) -> Any:
        if not self.is_configured:
            raise ProviderError(
                "OpenRouter provider is not configured",
                code="openrouter_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        payload["stream"] = True
        headers = self._build_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            async with client.stream("POST", self._chat_completions_url(), headers=headers, json=payload) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise build_provider_http_error(response, provider_name="openrouter")

                async for text in iter_sse_text(response):
                    yield text

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "OpenRouter request timed out",
                code="openrouter_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "OpenRouter HTTP request failed",
                code="openrouter_http_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    def _chat_completions_url(self) -> str:
        return f"{self.config.base_url.rstrip('/')}/chat/completions"

    def _build_headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

        if self.config.app_url:
            headers["HTTP-Referer"] = self.config.app_url

        if self.config.app_title:
            headers["X-OpenRouter-Title"] = self.config.app_title

        return headers

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": sanitize_text(self.config.model, MAX_MODEL_NAME_CHARS),
            "messages": convert_openai_messages(list(request.messages), MAX_TEXT_CHARS),
            "temperature": max(0.0, min(float(request.temperature), 2.0)),
            "max_tokens": max(1, min(int(request.max_output_tokens), 8192)),
            "stream": False,
        }

        response_format = request.metadata.get("response_format") if request.metadata else None
        if isinstance(response_format, dict):
            payload["response_format"] = sanitize_jsonish(response_format)

        stop_sequences = request.metadata.get("stop_sequences") if request.metadata else None
        if isinstance(stop_sequences, list):
            cleaned_stops = [
                sanitize_text(str(item), 120)
                for item in stop_sequences[:8]
                if sanitize_text(str(item), 120)
            ]
            if cleaned_stops:
                payload["stop"] = cleaned_stops

        transforms = request.metadata.get("transforms") if request.metadata else None
        if isinstance(transforms, list):
            cleaned_transforms = [
                sanitize_text(str(item), 80)
                for item in transforms[:8]
                if sanitize_text(str(item), 80)
            ]
            if cleaned_transforms:
                payload["transforms"] = cleaned_transforms

        route = request.metadata.get("route") if request.metadata else None
        if isinstance(route, str) and route:
            payload["metadata"] = {
                "route": sanitize_text(route, 80),
                "request_id": sanitize_text(request.request_id, 120),
            }

        return payload


def _optional_header_value(value: object) -> str | None:
    cleaned = sanitize_text(str(value or ""), MAX_HEADER_VALUE_CHARS)
    return cleaned or None
