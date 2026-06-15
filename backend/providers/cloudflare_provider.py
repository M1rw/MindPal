# backend/providers/cloudflare_provider.py

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.core.security import sanitize_text
from backend.models.chat import LLMMessage, LLMRequest, LLMResponse, LLMRole


DEFAULT_CLOUDFLARE_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com"
DEFAULT_CLOUDFLARE_NATIVE_BASE_URL = "https://api.cloudflare.com/client/v4"
DEFAULT_CLOUDFLARE_GATEWAY_ID = "default"
DEFAULT_CLOUDFLARE_MODEL = "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8-fast"
DEFAULT_TIMEOUT_SECONDS = 20.0

MAX_MODEL_NAME_CHARS = 220
MAX_URL_CHARS = 600
MAX_API_KEY_CHARS = 4_000
MAX_GATEWAY_ID_CHARS = 120
MAX_ACCOUNT_ID_CHARS = 160
MAX_MESSAGE_CHARS = 24_000
MAX_ERROR_CHARS = 700


@dataclass(frozen=True, slots=True)
class CloudflareAIProviderConfig:
    """
    Cloudflare Workers AI provider through AI Gateway.

    Supported modes:
    - gateway_compat:
      https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
      header: cf-aig-authorization: Bearer <token>
      model: workers-ai/@cf/...

    - native:
      https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
      header: Authorization: Bearer <token>
      header: cf-aig-gateway-id: <gateway_id>
      model: @cf/...
    """

    token: str
    account_id: str
    gateway_id: str = DEFAULT_CLOUDFLARE_GATEWAY_ID
    model: str = DEFAULT_CLOUDFLARE_MODEL
    mode: str = "gateway_compat"
    gateway_base_url: str = DEFAULT_CLOUDFLARE_GATEWAY_BASE_URL
    native_base_url: str = DEFAULT_CLOUDFLARE_NATIVE_BASE_URL
    explicit_url: str = ""
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> CloudflareAIProviderConfig:
        settings = settings or get_settings()

        token = _first_non_empty(
            _secret_value(getattr(settings, "CLOUDFLARE_AIG_TOKEN", None)),
            _secret_value(getattr(settings, "CLOUDFLARE_API_TOKEN", None)),
            os.getenv("CF_AIG_TOKEN"),
            os.getenv("CLOUDFLARE_AIG_TOKEN"),
            os.getenv("CLOUDFLARE_API_TOKEN"),
            os.getenv("CLOUDFLARE_API_KEY"),
        )

        account_id = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_ACCOUNT_ID", "") or ""),
            os.getenv("CLOUDFLARE_ACCOUNT_ID"),
            os.getenv("CF_ACCOUNT_ID"),
        )

        gateway_id = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_GATEWAY_ID", "") or ""),
            os.getenv("CLOUDFLARE_GATEWAY_ID"),
            os.getenv("CF_AIG_GATEWAY_ID"),
            DEFAULT_CLOUDFLARE_GATEWAY_ID,
        )

        model = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_MODEL", "") or ""),
            os.getenv("CLOUDFLARE_MODEL"),
            os.getenv("CF_AI_MODEL"),
            DEFAULT_CLOUDFLARE_MODEL,
        )

        mode = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_MODE", "") or ""),
            os.getenv("CLOUDFLARE_AI_MODE"),
            os.getenv("CF_AI_MODE"),
            "gateway_compat",
        ).lower()

        explicit_url = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_GATEWAY_URL", "") or ""),
            os.getenv("CLOUDFLARE_AI_GATEWAY_URL"),
            os.getenv("CF_AI_GATEWAY_URL"),
        )

        gateway_base_url = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_GATEWAY_BASE_URL", "") or ""),
            os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL"),
            DEFAULT_CLOUDFLARE_GATEWAY_BASE_URL,
        )

        native_base_url = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_NATIVE_BASE_URL", "") or ""),
            os.getenv("CLOUDFLARE_AI_NATIVE_BASE_URL"),
            DEFAULT_CLOUDFLARE_NATIVE_BASE_URL,
        )

        timeout_seconds_raw = _first_non_empty(
            str(getattr(settings, "CLOUDFLARE_TIMEOUT_SECONDS", "") or ""),
            os.getenv("CLOUDFLARE_TIMEOUT_SECONDS"),
            str(DEFAULT_TIMEOUT_SECONDS),
        )

        try:
            timeout_seconds = float(timeout_seconds_raw)
        except ValueError:
            timeout_seconds = DEFAULT_TIMEOUT_SECONDS

        return cls(
            token=sanitize_text(token, MAX_API_KEY_CHARS),
            account_id=sanitize_text(account_id, MAX_ACCOUNT_ID_CHARS),
            gateway_id=sanitize_text(gateway_id, MAX_GATEWAY_ID_CHARS) or DEFAULT_CLOUDFLARE_GATEWAY_ID,
            model=sanitize_text(model, MAX_MODEL_NAME_CHARS) or DEFAULT_CLOUDFLARE_MODEL,
            mode="native" if mode == "native" else "gateway_compat",
            gateway_base_url=sanitize_text(gateway_base_url, MAX_URL_CHARS) or DEFAULT_CLOUDFLARE_GATEWAY_BASE_URL,
            native_base_url=sanitize_text(native_base_url, MAX_URL_CHARS) or DEFAULT_CLOUDFLARE_NATIVE_BASE_URL,
            explicit_url=sanitize_text(explicit_url, MAX_URL_CHARS),
            timeout_seconds=max(1.0, min(timeout_seconds, 120.0)),
        )


class CloudflareAIProvider:
    name = "cloudflare"

    def __init__(self, config: CloudflareAIProviderConfig | None = None) -> None:
        self.config = config or CloudflareAIProviderConfig.from_settings()

    @property
    def is_configured(self) -> bool:
        if not self.config.token:
            return False

        if self.config.explicit_url:
            return True

        return bool(self.config.account_id)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        if not self.is_configured:
            raise ProviderError(
                "Cloudflare Workers AI provider is not configured",
                code="cloudflare_not_configured",
            )

        payload = self._build_payload(request)

        try:
            async with httpx.AsyncClient(timeout=self.config.timeout_seconds) as client:
                response = await client.post(
                    self._endpoint_url(),
                    headers=self._headers(),
                    json=payload,
                )

            if response.status_code >= 400:
                raise _cloudflare_http_error(response)

            try:
                data = response.json()
            except ValueError as exc:
                raise ProviderError(
                    "Cloudflare Workers AI response was not valid JSON",
                    code="cloudflare_invalid_json",
                ) from exc

            text = _extract_text(data)

            if not text:
                raise ProviderError(
                    "Cloudflare Workers AI returned an empty response",
                    code="cloudflare_empty_response",
                )

            return LLMResponse(
                text=sanitize_text(text, MAX_MESSAGE_CHARS),
                provider_used=self.name,
                fallback_count=0,
                latency_ms=0.0,
                model_name=_extract_model_name(data, self.config.model),
                finish_reason=_extract_finish_reason(data),
            )

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Cloudflare Workers AI request timed out",
                code="cloudflare_timeout",
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Cloudflare Workers AI HTTP request failed",
                code="cloudflare_http_error",
                details={"error": sanitize_text(str(exc), MAX_ERROR_CHARS)},
            ) from exc

    async def generate_stream(self, request: LLMRequest) -> Any:
        if not self.is_configured:
            raise ProviderError(
                "Cloudflare Workers AI provider is not configured",
                code="cloudflare_not_configured",
            )

        payload = self._build_payload(request)
        payload["stream"] = True

        try:
            async with httpx.AsyncClient(timeout=self.config.timeout_seconds) as client:
                async with client.stream("POST", self._endpoint_url(), headers=self._headers(), json=payload) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise _cloudflare_http_error(response)

                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:]
                            if data_str.strip() == "[DONE]":
                                break
                            import json
                            try:
                                data = json.loads(data_str)
                                text = _extract_text(data)
                                if text:
                                    yield text
                            except json.JSONDecodeError:
                                pass

        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                "Cloudflare Workers AI request timed out",
                code="cloudflare_timeout",
            ) from exc

        except httpx.HTTPError as exc:
            raise ProviderError(
                "Cloudflare Workers AI HTTP request failed",
                code="cloudflare_http_error",
                details={"error": sanitize_text(str(exc), MAX_ERROR_CHARS)},
            ) from exc

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.is_configured:
            raise ProviderError(
                "Cloudflare Workers AI provider is not configured",
                code="cloudflare_not_configured",
            )

        # Cloudflare text-embedding endpoint format
        # https://developers.cloudflare.com/workers-ai/models/text-embeddings/
        # Endpoint: POST /v1/{account_id}/ai/run/@cf/baai/bge-small-en-v1.5
        # or via Gateway compat...
        # Wait, if we use Gateway compat:
        # POST /v1/{account_id}/{gateway_id}/workers-ai/@cf/baai/bge-small-en-v1.5
        # Payload: {"text": texts}

        model = "@cf/baai/bge-small-en-v1.5"
        
        # Always use the native workers-ai run endpoint for embeddings 
        # as it's the most reliable across configurations
        if self.config.explicit_url:
            url = f"{self.config.explicit_url.rstrip('/')}/embeddings"
        else:
            url = f"{self.config.native_base_url.rstrip('/')}/accounts/{self.config.account_id}/ai/run/{model}"
            
        payload = {"text": texts}
        
        # Must use Authorization for native endpoints
        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "Content-Type": "application/json",
        }
        
        try:
            async with httpx.AsyncClient(timeout=self.config.timeout_seconds) as client:
                response = await client.post(url, headers=headers, json=payload)
                
            if response.status_code >= 400:
                print(f"Cloudflare API Error {response.status_code}: {response.text}")
                raise _cloudflare_http_error(response)
                
            data = response.json()
            result = data.get("result", {})
            embeddings = result.get("data", [])
            
            return embeddings
            
        except Exception as exc:
            raise ProviderError(
                "Cloudflare Workers AI embed request failed",
                code="cloudflare_embed_error",
                details={"error": str(exc)},
            ) from exc

    def _endpoint_url(self) -> str:
        if self.config.explicit_url:
            return self.config.explicit_url.rstrip("/")

        if self.config.mode == "native":
            return (
                f"{self.config.native_base_url.rstrip('/')}"
                f"/accounts/{self.config.account_id}/ai/v1/chat/completions"
            )

        return (
            f"{self.config.gateway_base_url.rstrip('/')}"
            f"/v1/{self.config.account_id}/{self.config.gateway_id}/compat/chat/completions"
        )

    def _headers(self) -> dict[str, str]:
        if self.config.mode == "native":
            return {
                "Authorization": f"Bearer {self.config.token}",
                "cf-aig-gateway-id": self.config.gateway_id,
                "Content-Type": "application/json",
            }

        return {
            "cf-aig-authorization": f"Bearer {self.config.token}",
            "Content-Type": "application/json",
        }

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        model = self.config.model

        if self.config.mode == "native" and model.startswith("workers-ai/"):
            model = model.removeprefix("workers-ai/")

        payload: dict[str, Any] = {
            "model": sanitize_text(model, MAX_MODEL_NAME_CHARS),
            "messages": _convert_messages(list(request.messages)),
            "temperature": float(request.temperature),
            "max_tokens": int(request.max_output_tokens),
        }

        # Keep deterministic-ish support behavior. Cloudflare/OpenAI-compatible
        # endpoints may ignore unsupported params safely less often than they
        # reject them, so keep payload minimal.
        return payload


def _convert_messages(messages: list[LLMMessage]) -> list[dict[str, str]]:
    converted: list[dict[str, str]] = []

    for message in messages:
        content = sanitize_text(message.content, MAX_MESSAGE_CHARS)

        if not content:
            continue

        converted.append(
            {
                "role": _convert_role(message.role),
                "content": content,
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

    if isinstance(choices, list) and choices:
        first = choices[0] or {}
        message = first.get("message") or {}

        if isinstance(message, dict):
            content = message.get("content")

            if isinstance(content, str):
                return content

            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                return "\n".join(parts)

        if isinstance(first.get("text"), str):
            return first["text"]

    result = data.get("result")

    if isinstance(result, dict):
        for key in ("response", "text", "content"):
            if isinstance(result.get(key), str):
                return result[key]

    for key in ("response", "text", "content"):
        if isinstance(data.get(key), str):
            return data[key]

    return ""


def _extract_model_name(data: dict[str, Any], fallback_model: str) -> str:
    model = data.get("model")

    if model:
        return sanitize_text(str(model), MAX_MODEL_NAME_CHARS)

    return sanitize_text(fallback_model, MAX_MODEL_NAME_CHARS)


def _extract_finish_reason(data: dict[str, Any]) -> str | None:
    choices = data.get("choices")

    if isinstance(choices, list) and choices:
        first = choices[0] or {}
        finish_reason = first.get("finish_reason")

        if finish_reason:
            return sanitize_text(str(finish_reason), 120)

    return None


def _cloudflare_http_error(response: httpx.Response) -> ProviderError:
    error_code = "cloudflare_http_error"
    error_message = ""

    try:
        data = response.json()
    except ValueError:
        data = {}

    if isinstance(data, dict):
        errors = data.get("errors")
        if isinstance(errors, list) and errors:
            first = errors[0] or {}
            error_message = str(first.get("message") or "")
            code_value = first.get("code")
            if code_value:
                error_code = f"cloudflare_{code_value}"

        error = data.get("error")
        if isinstance(error, dict):
            error_message = error_message or str(error.get("message") or "")
            code_value = error.get("code") or error.get("type")
            if code_value:
                error_code = f"cloudflare_{str(code_value).lower()}"

    if not error_message:
        error_message = response.text[:MAX_ERROR_CHARS]

    return ProviderError(
        "Cloudflare Workers AI provider returned an error",
        code=sanitize_text(error_code, 120) or "cloudflare_http_error",
        details={
            "status_code": response.status_code,
            "error": sanitize_text(error_message, MAX_ERROR_CHARS),
        },
    )


def _secret_value(value: Any) -> str:
    if value is None:
        return ""

    getter = getattr(value, "get_secret_value", None)

    if callable(getter):
        return str(getter() or "")

    return str(value or "")


def _first_non_empty(*values: Any) -> str:
    for value in values:
        clean = str(value or "").strip()
        if clean:
            return clean

    return ""
