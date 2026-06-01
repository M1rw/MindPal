# backend/providers/groq_provider.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.models.chat import LLMMessage, LLMRequest, LLMResponse, LLMRole


DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"
DEFAULT_TIMEOUT_SECONDS = 30.0

MAX_BASE_URL_CHARS = 300
MAX_MODEL_NAME_CHARS = 160
MAX_PROVIDER_ERROR_CHARS = 600
MAX_TEXT_CHARS = 80_000


@dataclass(frozen=True, slots=True)
class GroqProviderConfig:
    api_key: str
    model: str = DEFAULT_GROQ_MODEL
    base_url: str = DEFAULT_GROQ_BASE_URL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> GroqProviderConfig:
        settings = settings or get_settings()

        return cls(
            api_key=sanitize_text(
                str(getattr(settings, "GROQ_API_KEY", "") or ""),
                4_000,
            ),
            model=sanitize_text(
                str(getattr(settings, "GROQ_MODEL", DEFAULT_GROQ_MODEL) or DEFAULT_GROQ_MODEL),
                MAX_MODEL_NAME_CHARS,
            ),
            base_url=sanitize_text(
                str(getattr(settings, "GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL) or DEFAULT_GROQ_BASE_URL),
                MAX_BASE_URL_CHARS,
            ).rstrip("/"),
            timeout_seconds=float(
                getattr(settings, "GROQ_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
                or DEFAULT_TIMEOUT_SECONDS
            ),
        )


class GroqProvider:
    """
    Groq OpenAI-compatible chat-completions provider for LLMService.

    Boundary:
    - no network call at import
    - no Groq/OpenAI SDK import
    - API key is sent in Authorization header only
    - provider errors are redacted before surfacing
    - raw HTTP payload is not exposed in exceptions
    - non-streaming only
    """

    name = "groq"

    def __init__(
        self,
        config: GroqProviderConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or GroqProviderConfig.from_settings()
        self._client = client

    @property
    def is_configured(self) -> bool:
        return bool(self.config.api_key)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        if not self.is_configured:
            raise ProviderError(
                "Groq provider is not configured",
                code="groq_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.post(
                self._chat_completions_url(),
                headers=headers,
                json=payload,
            )

            if response.status_code >= 400:
                raise self._provider_http_error(response)

            data = response.json()
            text = _extract_text(data)

            if not text:
                raise ProviderError(
                    "Groq returned an empty response",
                    code="groq_empty_response",
                    details=_extract_safe_response_metadata(data),
                )

            return LLMResponse(
                text=text,
                provider_used=self.name,
                fallback_count=0,
                latency_ms=0.0,
                model_name=_extract_model_name(data, self.config.model),
                finish_reason=_extract_finish_reason(data),
            )

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Groq request timed out",
                code="groq_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Groq HTTP request failed",
                code="groq_http_error",
                details={
                    "provider": self.name,
                    "error": _clean_error(str(exc)),
                },
            ) from exc

        except ValueError as exc:
            raise ProviderError(
                "Groq response was not valid JSON",
                code="groq_invalid_json",
                details={"provider": self.name},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    def _chat_completions_url(self) -> str:
        return f"{self.config.base_url.rstrip('/')}/chat/completions"

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": sanitize_text(self.config.model, MAX_MODEL_NAME_CHARS),
            "messages": _convert_messages(request.messages),
            "temperature": max(0.0, min(float(request.temperature), 2.0)),
            "max_tokens": max(1, min(int(request.max_output_tokens), 8192)),
            "stream": False,
        }

        stop_sequences = request.metadata.get("stop_sequences") if request.metadata else None
        if isinstance(stop_sequences, list):
            cleaned_stops = [
                sanitize_text(str(item), 120)
                for item in stop_sequences[:8]
                if sanitize_text(str(item), 120)
            ]
            if cleaned_stops:
                payload["stop"] = cleaned_stops

        response_format = request.metadata.get("response_format") if request.metadata else None
        if isinstance(response_format, dict):
            payload["response_format"] = _sanitize_jsonish(response_format)

        # Groq-specific optional knobs. Only pass if explicitly requested.
        reasoning_format = request.metadata.get("reasoning_format") if request.metadata else None
        if isinstance(reasoning_format, str) and reasoning_format:
            payload["reasoning_format"] = sanitize_text(reasoning_format, 80)

        service_tier = request.metadata.get("service_tier") if request.metadata else None
        if isinstance(service_tier, str) and service_tier:
            payload["service_tier"] = sanitize_text(service_tier, 80)

        seed = request.metadata.get("seed") if request.metadata else None
        if isinstance(seed, int):
            payload["seed"] = seed

        route = request.metadata.get("route") if request.metadata else None
        if isinstance(route, str) and route:
            payload["metadata"] = {
                "route": sanitize_text(route, 80),
                "request_id": sanitize_text(request.request_id, 120),
            }

        return payload


def _convert_messages(messages: list[LLMMessage]) -> list[dict[str, str]]:
    converted: list[dict[str, str]] = []

    for message in messages:
        content = sanitize_text(message.content, MAX_TEXT_CHARS)

        if not content:
            continue

        converted.append(
            {
                "role": _convert_role(message.role),
                "content": content,
            }
        )

    if not converted:
        converted.append(
            {
                "role": "user",
                "content": "Continue.",
            }
        )

    return converted


def _convert_role(role: LLMRole) -> str:
    if role == LLMRole.SYSTEM:
        return "system"

    if role == LLMRole.ASSISTANT:
        return "assistant"

    return "user"


def _extract_text(data: dict[str, Any]) -> str:
    choices = data.get("choices")

    if not isinstance(choices, list) or not choices:
        return ""

    first = choices[0]

    if not isinstance(first, dict):
        return ""

    message = first.get("message")

    if isinstance(message, dict):
        content = message.get("content")

        if isinstance(content, str):
            return sanitize_text(content, MAX_TEXT_CHARS)

        if isinstance(content, list):
            return sanitize_text(_extract_content_list_text(content), MAX_TEXT_CHARS)

    text = first.get("text")

    if isinstance(text, str):
        return sanitize_text(text, MAX_TEXT_CHARS)

    delta = first.get("delta")

    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return sanitize_text(str(delta["content"]), MAX_TEXT_CHARS)

    return ""


def _extract_content_list_text(content: list[Any]) -> str:
    parts: list[str] = []

    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue

        if not isinstance(item, dict):
            continue

        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)

    return "\n".join(parts)


def _extract_finish_reason(data: dict[str, Any]) -> str:
    choices = data.get("choices")

    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return sanitize_text(str(choices[0].get("finish_reason") or "unknown"), 80)

    return "unknown"


def _extract_model_name(data: dict[str, Any], fallback_model: str) -> str:
    model = data.get("model")

    if model:
        return sanitize_text(str(model), MAX_MODEL_NAME_CHARS)

    return sanitize_text(fallback_model, MAX_MODEL_NAME_CHARS)


def _extract_safe_response_metadata(data: dict[str, Any]) -> dict[str, str]:
    metadata: dict[str, str] = {}

    if data.get("id"):
        metadata["response_id_present"] = "true"

    if data.get("model"):
        metadata["model"] = sanitize_text(str(data["model"]), MAX_MODEL_NAME_CHARS)

    if data.get("system_fingerprint"):
        metadata["system_fingerprint_present"] = "true"

    if data.get("service_tier"):
        metadata["service_tier"] = sanitize_text(str(data["service_tier"]), 80)

    choices = data.get("choices")
    if isinstance(choices, list):
        metadata["choices_count"] = str(len(choices))

        if choices and isinstance(choices[0], dict):
            metadata["finish_reason"] = sanitize_text(
                str(choices[0].get("finish_reason") or ""),
                80,
            )

    usage = data.get("usage")
    if usage is not None:
        metadata["usage_present"] = "true"

    return metadata


def _provider_http_error(response: httpx.Response) -> ProviderError:
    status_code = response.status_code
    code = "groq_http_error"

    try:
        data = response.json()
    except ValueError:
        data = {}

    message = ""

    if isinstance(data, dict):
        error = data.get("error")

        if isinstance(error, dict):
            message = sanitize_text(str(error.get("message") or ""), MAX_PROVIDER_ERROR_CHARS)
            api_code = sanitize_text(str(error.get("code") or error.get("type") or ""), 120)
            if api_code:
                code = f"groq_{api_code.lower().replace(' ', '_')}"

        elif isinstance(error, str):
            message = sanitize_text(error, MAX_PROVIDER_ERROR_CHARS)

    if not message:
        message = sanitize_text(response.text, MAX_PROVIDER_ERROR_CHARS)

    message = _clean_error(message)

    return ProviderError(
        "Groq provider returned an error",
        code=code,
        details={
            "provider": "groq",
            "status_code": str(status_code),
            "message": message,
        },
    )


def _sanitize_jsonish(value: Any, *, depth: int = 3) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return sanitize_text(value, 300)

    if depth <= 0:
        return sanitize_text(str(value), 300)

    if isinstance(value, dict):
        return {
            sanitize_text(str(key), 120): _sanitize_jsonish(item, depth=depth - 1)
            for key, item in list(value.items())[:40]
            if sanitize_text(str(key), 120)
        }

    if isinstance(value, list):
        return [_sanitize_jsonish(item, depth=depth - 1) for item in value[:40]]

    return sanitize_text(str(value), 300)


def _clean_error(value: str) -> str:
    cleaned = redact_basic_pii(sanitize_text(value, MAX_PROVIDER_ERROR_CHARS))
    return cleaned or "provider_error"