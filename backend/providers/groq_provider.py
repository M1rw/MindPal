# backend/providers/groq_provider.py

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


DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
DEFAULT_TIMEOUT_SECONDS = 30.0

MAX_MODEL_NAME_CHARS = 160
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
            api_key=sanitize_text(setting_secret(settings, "GROQ_API_KEY"), 4_000),
            model=sanitize_text(
                str(getattr(settings, "GROQ_MODEL", DEFAULT_GROQ_MODEL) or DEFAULT_GROQ_MODEL),
                MAX_MODEL_NAME_CHARS,
            ),
            base_url=sanitize_text(
                str(getattr(settings, "GROQ_BASE_URL", DEFAULT_GROQ_BASE_URL) or DEFAULT_GROQ_BASE_URL),
                300,
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
        headers = self._auth_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.post(
                self._chat_completions_url(),
                headers=headers,
                json=payload,
            )

            if response.status_code >= 400:
                raise build_provider_http_error(response, provider_name="groq")

            data = response.json()
            text = extract_openai_text(data, MAX_TEXT_CHARS)

            if not text:
                raise ProviderError(
                    "Groq returned an empty response",
                    code="groq_empty_response",
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
                "Groq request timed out",
                code="groq_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Groq HTTP request failed",
                code="groq_http_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
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

    async def generate_stream(self, request: LLMRequest) -> Any:
        if not self.is_configured:
            raise ProviderError(
                "Groq provider is not configured",
                code="groq_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        payload["stream"] = True
        headers = self._auth_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            async with client.stream("POST", self._chat_completions_url(), headers=headers, json=payload) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise build_provider_http_error(response, provider_name="groq")

                async for text in iter_sse_text(response):
                    yield text

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
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def _chat_completions_url(self) -> str:
        return f"{self.config.base_url.rstrip('/')}/chat/completions"

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        messages = convert_openai_messages(list(request.messages), MAX_TEXT_CHARS)
        
        # Groq has a strict 8k token limit (approx 32k chars). 
        # We need to leave room for max_tokens (e.g. 1800).
        # We will keep the system prompt (first message) and the latest messages.
        max_total_chars = 22000
        total_chars = sum(len(m["content"]) for m in messages)
        
        if total_chars > max_total_chars and len(messages) > 2:
            system_msg = messages[0] if messages and messages[0]["role"] == "system" else None
            user_msg = messages[-1]
            
            kept_history = messages[1:-1] if system_msg else messages[:-1]
            while kept_history and total_chars > max_total_chars:
                dropped = kept_history.pop(0)
                total_chars -= len(dropped["content"])
                
            messages = [system_msg] + kept_history + [user_msg] if system_msg else kept_history + [user_msg]

        # 2. Re-enforce strictly alternating roles starting and ending with 'user' for Llama-3
        # If truncation dropped an odd number of messages, the sequence could break alternation.
        valid_messages = []
        if messages and messages[0]["role"] == "system":
            valid_messages.append(messages.pop(0))
            
        for msg in messages:
            if not valid_messages or (len(valid_messages) == 1 and valid_messages[0]["role"] == "system"):
                if msg["role"] == "assistant":
                    valid_messages.append({"role": "user", "content": "(Conversation context)"})
                valid_messages.append(msg)
            elif valid_messages[-1]["role"] == msg["role"]:
                valid_messages[-1]["content"] += "\n\n" + msg["content"]
            else:
                valid_messages.append(msg)
                
        if valid_messages and valid_messages[-1]["role"] == "assistant":
            valid_messages.append({"role": "user", "content": "Continue."})
            
        messages = valid_messages

        payload: dict[str, Any] = {
            "model": sanitize_text(self.config.model, MAX_MODEL_NAME_CHARS),
            "messages": messages,
            "temperature": max(0.01, min(float(request.temperature), 2.0)),
            "max_tokens": max(1, min(int(request.max_output_tokens), 8192)),
            "stream": False,
            # Prevent LLM repetition loops — especially critical for non-English text
            "frequency_penalty": 0.3,
            "presence_penalty": 0.1,
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
            payload["response_format"] = sanitize_jsonish(response_format)

        # Groq-specific optional knobs
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
