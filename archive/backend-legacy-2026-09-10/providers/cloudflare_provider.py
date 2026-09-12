# backend/providers/cloudflare_provider.py

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
    convert_openai_messages,
    extract_openai_finish_reason,
    extract_openai_model,
    extract_openai_text,
    first_non_empty,
    iter_sse_text,
    secret_value,
)


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

        token = first_non_empty(
            secret_value(getattr(settings, "CLOUDFLARE_AIG_TOKEN", None)),
            secret_value(getattr(settings, "CLOUDFLARE_API_TOKEN", None)),
        )
        account_id = str(getattr(settings, "CLOUDFLARE_ACCOUNT_ID", "") or "")
        gateway_id = first_non_empty(
            str(getattr(settings, "CLOUDFLARE_GATEWAY_ID", "") or ""),
            DEFAULT_CLOUDFLARE_GATEWAY_ID,
        )
        model = first_non_empty(
            str(getattr(settings, "CLOUDFLARE_MODEL", "") or ""),
            DEFAULT_CLOUDFLARE_MODEL,
        )
        mode = first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_MODE", "") or ""),
            "gateway_compat",
        ).lower()
        explicit_url = str(getattr(settings, "CLOUDFLARE_AI_GATEWAY_URL", "") or "")
        gateway_base_url = first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_GATEWAY_BASE_URL", "") or ""),
            DEFAULT_CLOUDFLARE_GATEWAY_BASE_URL,
        )
        native_base_url = first_non_empty(
            str(getattr(settings, "CLOUDFLARE_AI_NATIVE_BASE_URL", "") or ""),
            DEFAULT_CLOUDFLARE_NATIVE_BASE_URL,
        )
        timeout_seconds_raw = str(
            getattr(settings, "CLOUDFLARE_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
            or DEFAULT_TIMEOUT_SECONDS
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

    def __init__(
        self,
        config: CloudflareAIProviderConfig | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or CloudflareAIProviderConfig.from_settings()
        self._client = client

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
            owns_client = self._client is None
            client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)
            try:
                response = await client.post(
                    self._endpoint_url(),
                    headers=self._headers(),
                    json=payload,
                )
            finally:
                if owns_client:
                    await client.aclose()

            if response.status_code >= 400:
                raise build_provider_http_error(response, provider_name="cloudflare")

            try:
                data = response.json()
            except ValueError as exc:
                raise ProviderError(
                    "Cloudflare Workers AI response was not valid JSON",
                    code="cloudflare_invalid_json",
                ) from exc

            text = extract_openai_text(data, MAX_MESSAGE_CHARS)

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
                model_name=extract_openai_model(data, self.config.model, MAX_MODEL_NAME_CHARS),
                finish_reason=extract_openai_finish_reason(data),
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
            owns_client = self._client is None
            client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)
            try:
                async with client.stream("POST", self._endpoint_url(), headers=self._headers(), json=payload) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise build_provider_http_error(response, provider_name="cloudflare")

                    async for text in iter_sse_text(response):
                        yield text
            finally:
                if owns_client:
                    await client.aclose()

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

        model = "@cf/baai/bge-small-en-v1.5"

        if self.config.explicit_url:
            url = f"{self.config.explicit_url.rstrip('/')}/embeddings"
        else:
            url = f"{self.config.native_base_url.rstrip('/')}/accounts/{self.config.account_id}/ai/run/{model}"

        payload = {"text": texts}

        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "Content-Type": "application/json",
        }

        try:
            owns_client = self._client is None
            client = self._client or httpx.AsyncClient(timeout=self.config.timeout_seconds)
            try:
                response = await client.post(url, headers=headers, json=payload)
            finally:
                if owns_client:
                    await client.aclose()

            if response.status_code >= 400:
                raise build_provider_http_error(response, provider_name="cloudflare")

            data = response.json()
            result = data.get("result", {})
            return result.get("data", [])

        except ProviderError:
            raise

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

        return {
            "model": sanitize_text(model, MAX_MODEL_NAME_CHARS),
            "messages": convert_openai_messages(list(request.messages), MAX_MESSAGE_CHARS),
            "temperature": float(request.temperature),
            "max_tokens": int(request.max_output_tokens),
            # Prevent LLM repetition loops — especially critical for non-English text
            "frequency_penalty": 0.3,
            "presence_penalty": 0.1,
        }
