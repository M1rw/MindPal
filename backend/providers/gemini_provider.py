# backend/providers/gemini_provider.py

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any
from urllib.parse import quote

import httpx

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.models.chat import LLMMessage, LLMRequest, LLMResponse, LLMRole
from backend.providers._shared import (
    clean_error,
    setting_secret,
    iter_sse_text,
)


DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite"
DEFAULT_TIMEOUT_SECONDS = 45.0
MAX_MODEL_NAME_CHARS = 120
MAX_BASE_URL_CHARS = 300
MAX_PROVIDER_ERROR_CHARS = 500
MAX_TEXT_CHARS = 80_000


@dataclass(frozen=True, slots=True)
class GeminiProviderConfig:
    api_key: str
    model: str = DEFAULT_GEMINI_MODEL
    base_url: str = DEFAULT_GEMINI_BASE_URL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> GeminiProviderConfig:
        settings = settings or get_settings()

        return cls(
            api_key=sanitize_text(setting_secret(settings, "GEMINI_API_KEY"), 4_000),
            model=sanitize_text(
                str(getattr(settings, "GEMINI_MODEL", DEFAULT_GEMINI_MODEL) or DEFAULT_GEMINI_MODEL),
                MAX_MODEL_NAME_CHARS,
            ),
            base_url=sanitize_text(
                str(getattr(settings, "GEMINI_BASE_URL", DEFAULT_GEMINI_BASE_URL) or DEFAULT_GEMINI_BASE_URL),
                MAX_BASE_URL_CHARS,
            ).rstrip("/"),
            timeout_seconds=float(getattr(settings, "GEMINI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS) or DEFAULT_TIMEOUT_SECONDS),
        )


class GeminiProvider:
    """
    Gemini REST provider for LLMService.

    Safety boundary:
    - no network call at import
    - no SDK import
    - API key is sent by header, not placed in logged URLs
    - provider errors are redacted before surfacing
    - raw HTTP payload is not exposed in exceptions
    """

    name = "gemini"

    def __init__(
        self,
        config: GeminiProviderConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or GeminiProviderConfig.from_settings()
        self._client = client

    @property
    def is_configured(self) -> bool:
        return bool(self.config.api_key)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        if not self.is_configured:
            raise ProviderError(
                "Gemini provider is not configured",
                code="gemini_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        url = self._build_url()
        headers = self._auth_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            response = await client.post(url, headers=headers, json=payload)

            if response.status_code >= 400:
                raise _provider_http_error(response)

            data = response.json()
            text = _extract_text(data)

            if not text:
                raise ProviderError(
                    "Gemini returned an empty response",
                    code="gemini_empty_response",
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
                "Gemini request timed out",
                code="gemini_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Gemini HTTP request failed",
                code="gemini_http_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        except ValueError as exc:
            raise ProviderError(
                "Gemini response was not valid JSON",
                code="gemini_invalid_json",
                details={"provider": self.name},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    async def generate_stream(self, request: LLMRequest) -> Any:
        if not self.is_configured:
            raise ProviderError(
                "Gemini provider is not configured",
                code="gemini_not_configured",
                details={"provider": self.name},
            )

        payload = self._build_payload(request)
        url = self._build_url(stream=True)
        headers = self._auth_headers()

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise _provider_http_error(response)

                async for text in iter_sse_text(response, _extract_delta_text):
                    yield text

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Gemini request timed out",
                code="gemini_timeout",
                details={"provider": self.name},
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Gemini HTTP request failed",
                code="gemini_http_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.is_configured:
            raise ProviderError(
                "Gemini provider is not configured",
                code="gemini_not_configured",
                details={"provider": self.name},
            )

        headers = self._auth_headers()
        base_url = self.config.base_url.rstrip("/")

        # Try embedding models in order (newest first)
        # text-embedding-004 was deprecated → 404
        embed_models = [
            "gemini-embedding-2",
            "gemini-embedding-001",
            "text-embedding-004",  # legacy fallback
        ]

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)

        try:
            for embed_model in embed_models:
                url = f"{base_url}/models/{embed_model}:embedContent"
                embeddings = []
                all_ok = True

                for text in texts:
                    payload = {
                        "model": f"models/{embed_model}",
                        "content": {
                            "parts": [{"text": text}]
                        }
                    }
                    try:
                        response = await client.post(url, headers=headers, json=payload)
                        if response.status_code == 404:
                            all_ok = False
                            break  # Try next model
                        if response.status_code >= 400:
                            raise _provider_http_error(response)

                        data = response.json()
                        val = data.get("embedding", {}).get("values", [])
                        embeddings.append(val)
                    except ProviderError:
                        raise
                    except Exception:
                        all_ok = False
                        break

                if all_ok and embeddings:
                    return embeddings

            # All models failed with 404
            raise ProviderError(
                "No embedding model available",
                code="gemini_embed_not_available",
                details={"provider": self.name},
            )

        except ProviderError:
            raise

        except Exception as exc:
            raise ProviderError(
                "Gemini embed request failed",
                code="gemini_embed_error",
                details={"provider": self.name, "error": clean_error(str(exc))},
            ) from exc

        finally:
            if owns_client:
                await client.aclose()

    def _auth_headers(self) -> dict[str, str]:
        """Standard Gemini auth headers — key in header, never in URL."""
        return {
            "Content-Type": "application/json",
            "x-goog-api-key": self.config.api_key,
        }

    def _build_url(self, stream: bool = False) -> str:
        base_url = self.config.base_url.rstrip("/")
        model_path = _normalize_model_path(self.config.model)
        encoded_model_path = "/".join(quote(part, safe="") for part in model_path.split("/"))
        if stream:
            return f"{base_url}/{encoded_model_path}:streamGenerateContent?alt=sse"
        return f"{base_url}/{encoded_model_path}:generateContent"

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        system_text, contents = _convert_messages(request.messages)

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": _build_generation_config(request),
        }

        if system_text:
            payload["systemInstruction"] = {
                "parts": [{"text": system_text}]
            }

        # Ask Gemini not to store request/response when supported by the API.
        payload["store"] = False

        return payload


# ═══════════════════════════════════════════════════════════════
# Gemini-specific helpers (not shared — Gemini uses a different format)
# ═══════════════════════════════════════════════════════════════

def _convert_messages(messages: list[LLMMessage]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []

    for message in messages:
        content = sanitize_text(message.content, MAX_TEXT_CHARS)
        if not content:
            continue

        if message.role == LLMRole.SYSTEM:
            system_parts.append(content)
            continue

        role = "model" if message.role == LLMRole.ASSISTANT else "user"
        contents.append({"role": role, "parts": [{"text": content}]})

    if not contents:
        contents.append({"role": "user", "parts": [{"text": "Continue."}]})

    system_text = "\n\n".join(system_parts)
    return system_text, contents


def _build_generation_config(request: LLMRequest) -> dict[str, Any]:
    config: dict[str, Any] = {
        "temperature": max(0.0, min(float(request.temperature), 2.0)),
        "maxOutputTokens": max(1, min(int(request.max_output_tokens), 8192)),
        # Prevent LLM repetition loops — especially critical for non-English text
        "frequencyPenalty": 0.3,
        "presencePenalty": 0.1,
    }

    response_mime_type = request.metadata.get("response_mime_type") if request.metadata else None
    if response_mime_type:
        config["responseMimeType"] = sanitize_text(str(response_mime_type), 80)

    stop_sequences = request.metadata.get("stop_sequences") if request.metadata else None
    if isinstance(stop_sequences, list):
        cleaned_stops = [
            sanitize_text(str(item), 120)
            for item in stop_sequences[:8]
            if sanitize_text(str(item), 120)
        ]
        if cleaned_stops:
            config["stopSequences"] = cleaned_stops

    return config


def _extract_text(data: dict[str, Any]) -> str:
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""

    first = candidates[0]
    if not isinstance(first, dict):
        return ""

    content = first.get("content")
    if not isinstance(content, dict):
        return ""

    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""

    text_parts: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            text_parts.append(text)

    return sanitize_text("\n".join(text_parts), MAX_TEXT_CHARS)


def _extract_delta_text(data: dict[str, Any]) -> str:
    """Streaming-safe: extract text without sanitize_text to preserve spaces."""
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""

    first = candidates[0]
    if not isinstance(first, dict):
        return ""

    content = first.get("content")
    if not isinstance(content, dict):
        return ""

    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""

    text_parts: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str):
            text_parts.append(text)

    return "\n".join(text_parts) if text_parts else ""


def _extract_finish_reason(data: dict[str, Any]) -> str:
    candidates = data.get("candidates")
    if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict):
        return sanitize_text(str(candidates[0].get("finishReason") or "unknown"), 80)

    prompt_feedback = data.get("promptFeedback")
    if prompt_feedback:
        return "prompt_feedback"

    return "unknown"


def _extract_model_name(data: dict[str, Any], fallback_model: str) -> str:
    model_version = data.get("modelVersion")
    if model_version:
        return sanitize_text(str(model_version), MAX_MODEL_NAME_CHARS)
    return sanitize_text(fallback_model, MAX_MODEL_NAME_CHARS)


def _extract_safe_response_metadata(data: dict[str, Any]) -> dict[str, str]:
    metadata: dict[str, str] = {}

    prompt_feedback = data.get("promptFeedback")
    if prompt_feedback is not None:
        metadata["prompt_feedback"] = sanitize_text(str(prompt_feedback), MAX_PROVIDER_ERROR_CHARS)

    candidates = data.get("candidates")
    if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict):
        candidate = candidates[0]
        metadata["finish_reason"] = sanitize_text(str(candidate.get("finishReason") or ""), 80)

        safety_ratings = candidate.get("safetyRatings")
        if safety_ratings is not None:
            metadata["safety_ratings_present"] = "true"

    return metadata


def _normalize_model_path(model: str) -> str:
    cleaned = sanitize_text(model or DEFAULT_GEMINI_MODEL, MAX_MODEL_NAME_CHARS)
    if not cleaned:
        cleaned = DEFAULT_GEMINI_MODEL

    if cleaned.startswith("models/"):
        return cleaned

    return f"models/{cleaned}"


def _provider_http_error(response: httpx.Response) -> ProviderError:
    status_code = response.status_code
    code = "gemini_http_error"

    try:
        data = response.json()
    except ValueError:
        data = {}

    message = ""

    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = sanitize_text(str(error.get("message") or ""), MAX_PROVIDER_ERROR_CHARS)
            api_code = sanitize_text(str(error.get("status") or ""), 120)
            if api_code:
                code = f"gemini_{api_code.lower()}"

    if not message:
        message = sanitize_text(response.text, MAX_PROVIDER_ERROR_CHARS)

    message = clean_error(message)

    return ProviderError(
        "Gemini provider returned an error",
        code=code,
        details={
            "provider": "gemini",
            "status_code": str(status_code),
            "message": message,
        },
    )
