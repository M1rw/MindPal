# backend/providers/_shared.py

"""
Shared provider utilities.

This module contains functions that were duplicated across multiple provider
files. Each provider imports what it needs from here instead of defining its
own copy.

No external SDK imports — only depends on backend.core.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from backend.core.config import Settings
from backend.core.errors import ProviderError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.models.chat import LLMMessage, LLMRole


# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════

MAX_TEXT_CHARS = 80_000
MAX_MODEL_NAME_CHARS = 160
MAX_ERROR_CHARS = 600


# ═══════════════════════════════════════════════════════════════
# Settings helpers
# ═══════════════════════════════════════════════════════════════

def setting_secret(settings: Settings, name: str, default: str = "") -> str:
    """Extract a secret value from settings, handling SecretStr."""
    value = getattr(settings, name, None)

    if value is None:
        return default

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value() or default

    return str(value or default)


def setting_value(settings: Settings, name: str, default: Any = None) -> Any:
    """Extract a value from settings with env fallback."""
    value = getattr(settings, name, None)

    if value is None:
        return os.getenv(name, default)

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def setting_bool(settings: Settings, name: str, *, default: bool) -> bool:
    """Extract a boolean from settings."""
    value = setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def secret_value(value: Any) -> str:
    """Extract string from a value that may be a SecretStr."""
    if value is None:
        return ""

    getter = getattr(value, "get_secret_value", None)

    if callable(getter):
        return str(getter() or "")

    return str(value or "")


def first_non_empty(*values: Any) -> str:
    """Return the first non-empty string value."""
    for value in values:
        clean = str(value or "").strip()
        if clean:
            return clean

    return ""


# ═══════════════════════════════════════════════════════════════
# Error helpers
# ═══════════════════════════════════════════════════════════════

def clean_error(value: str, max_chars: int = MAX_ERROR_CHARS) -> str:
    """Sanitize and redact PII from error messages."""
    cleaned = redact_basic_pii(sanitize_text(value, max_chars))
    return cleaned or "provider_error"


def build_provider_http_error(
    response: httpx.Response,
    *,
    provider_name: str,
    error_format: str = "openai",
    max_error_chars: int = MAX_ERROR_CHARS,
) -> ProviderError:
    """
    Build a ProviderError from an HTTP error response.

    Supports two formats:
    - "openai": OpenAI-compatible error shape (groq, openrouter, cloudflare)
    - "gemini": Gemini REST error shape
    """
    status_code = response.status_code
    code = f"{provider_name}_http_error"

    try:
        data = response.json()
    except ValueError:
        data = {}

    message = ""

    if isinstance(data, dict):
        error = data.get("error")

        if error_format == "gemini" and isinstance(error, dict):
            message = sanitize_text(str(error.get("message") or ""), max_error_chars)
            api_code = sanitize_text(str(error.get("status") or ""), 120)
            if api_code:
                code = f"{provider_name}_{api_code.lower()}"

        elif isinstance(error, dict):
            message = sanitize_text(str(error.get("message") or ""), max_error_chars)
            api_code = sanitize_text(
                str(error.get("code") or error.get("type") or ""), 120
            )
            if api_code:
                code = f"{provider_name}_{api_code.lower().replace(' ', '_')}"

        elif isinstance(error, str):
            message = sanitize_text(error, max_error_chars)

        # Cloudflare "errors" array format
        errors = data.get("errors")
        if not message and isinstance(errors, list) and errors:
            first = errors[0] or {}
            message = str(first.get("message") or "")
            code_val = first.get("code")
            if code_val:
                code = f"{provider_name}_{code_val}"

    if not message:
        message = sanitize_text(response.text, max_error_chars)

    message = clean_error(message, max_error_chars)

    return ProviderError(
        f"{provider_name.capitalize()} provider returned an error",
        code=sanitize_text(code, 120) or f"{provider_name}_http_error",
        details={
            "provider": provider_name,
            "status_code": str(status_code),
            "message": message,
        },
    )


# ═══════════════════════════════════════════════════════════════
# OpenAI-compatible response parsing
# (used by groq, openrouter, cloudflare)
# ═══════════════════════════════════════════════════════════════

def extract_openai_text(data: dict[str, Any], max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract text from an OpenAI-compatible chat completion response."""
    choices = data.get("choices")

    if not isinstance(choices, list) or not choices:
        # Cloudflare Workers AI fallback formats
        result = data.get("result")
        if isinstance(result, dict):
            for key in ("response", "text", "content"):
                if isinstance(result.get(key), str):
                    return sanitize_text(result[key], max_chars)

        for key in ("response", "text", "content"):
            if isinstance(data.get(key), str):
                return sanitize_text(data[key], max_chars)

        return ""

    first = choices[0]
    if not isinstance(first, dict):
        return ""

    # Standard message format
    message = first.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return sanitize_text(content, max_chars)
        if isinstance(content, list):
            return sanitize_text(_extract_content_list_text(content), max_chars)

    # Fallback: direct text
    text = first.get("text")
    if isinstance(text, str):
        return sanitize_text(text, max_chars)

    # Streaming delta format
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return sanitize_text(str(delta["content"]), max_chars)

    return ""


def _extract_content_list_text(content: list[Any]) -> str:
    """Extract text from an array-style content field."""
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


def extract_openai_model(
    data: dict[str, Any],
    fallback: str,
    max_chars: int = MAX_MODEL_NAME_CHARS,
) -> str:
    """Extract model name from an OpenAI-compatible response."""
    model = data.get("model")
    if model:
        return sanitize_text(str(model), max_chars)
    return sanitize_text(fallback, max_chars)


def extract_openai_finish_reason(data: dict[str, Any]) -> str:
    """Extract finish reason from an OpenAI-compatible response."""
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return sanitize_text(str(choices[0].get("finish_reason") or "unknown"), 80)
    return "unknown"


def extract_openai_metadata(data: dict[str, Any]) -> dict[str, str]:
    """Extract safe metadata from an OpenAI-compatible response."""
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
                str(choices[0].get("finish_reason") or ""), 80
            )

    usage = data.get("usage")
    if usage is not None:
        metadata["usage_present"] = "true"

    return metadata


# ═══════════════════════════════════════════════════════════════
# OpenAI-compatible message conversion
# ═══════════════════════════════════════════════════════════════

def convert_openai_messages(
    messages: list[LLMMessage],
    max_chars: int = MAX_TEXT_CHARS,
) -> list[dict[str, str]]:
    """Convert LLMMessages to OpenAI-compatible message dicts."""
    converted: list[dict[str, str]] = []

    for message in messages:
        content = sanitize_text(message.content, max_chars)
        if not content:
            continue

        converted.append({
            "role": convert_openai_role(message.role),
            "content": content,
        })

    if not converted:
        converted.append({"role": "user", "content": "Continue."})

    return converted


def convert_openai_role(role: LLMRole) -> str:
    """Convert LLMRole to OpenAI-compatible role string."""
    if role == LLMRole.SYSTEM:
        return "system"
    if role == LLMRole.ASSISTANT:
        return "assistant"
    return "user"


# ═══════════════════════════════════════════════════════════════
# Payload sanitization
# ═══════════════════════════════════════════════════════════════

def sanitize_jsonish(value: Any, *, depth: int = 3) -> Any:
    """Recursively sanitize a JSON-like value for safe use in payloads."""
    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return sanitize_text(value, 300)

    if depth <= 0:
        return sanitize_text(str(value), 300)

    if isinstance(value, dict):
        return {
            sanitize_text(str(key), 120): sanitize_jsonish(item, depth=depth - 1)
            for key, item in list(value.items())[:40]
            if sanitize_text(str(key), 120)
        }

    if isinstance(value, list):
        return [sanitize_jsonish(item, depth=depth - 1) for item in value[:40]]

    return sanitize_text(str(value), 300)


# ═══════════════════════════════════════════════════════════════
# SSE streaming
# ═══════════════════════════════════════════════════════════════

async def iter_sse_text(response: httpx.Response, extract_text_fn=None):
    """
    Iterate SSE lines from an HTTP streaming response, yielding extracted text.

    Uses extract_openai_text by default if no custom extractor is provided.
    """
    extractor = extract_text_fn or extract_openai_text

    async for line in response.aiter_lines():
        if line.startswith("data: "):
            data_str = line[6:]
            if data_str.strip() == "[DONE]":
                break
            try:
                data = json.loads(data_str)
                text = extractor(data)
                if text:
                    yield text
            except json.JSONDecodeError:
                pass
