# backend/infra/llm/openrouter.py — OpenAI-compatible provider (OpenRouter, Groq, …)
#
# Why this exists: Gemini's quota is one pool, and the only thing that genuinely
# requires Gemini is the Live native-audio socket. Chat, the crisis classifier and
# the call recap are ordinary text calls. Running them through a second provider
# keeps the whole Gemini allocation for Live, and stops a text-quota exhaustion
# from taking the live-voice safety classifier down with it — which is exactly
# what happened.
#
# The transport is the OpenAI chat-completions shape, so the same client speaks
# to OpenRouter, Groq, Together, or anything else that implements it.

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, AsyncGenerator, Dict, Iterable, List, Optional, Sequence

import httpx

logger = logging.getLogger("mindpal.llm")

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Free-tier OpenRouter models are rate limited and their data policies vary by
# upstream provider. Validate any classifier choice with
# scripts/validate_voice_classifier.py before trusting it on the safety path.
DEFAULT_OPENROUTER_CHAT_MODEL = "meta-llama/llama-3.3-70b-instruct"
DEFAULT_OPENROUTER_JSON_MODEL = "meta-llama/llama-3.3-70b-instruct"

# Short structured calls gate the live-voice microphone; long chat streams do not.
JSON_TIMEOUT_S = 6.0
STREAM_TIMEOUT_S = 60.0


class OpenAICompatibleError(Exception):
    """Transport or provider failure. Carries the status so 429 stays legible."""

    def __init__(self, message: str, status: int = 0) -> None:
        self.status = status
        super().__init__(message)

    @property
    def is_rate_limited(self) -> bool:
        if self.status == 429:
            return True
        text = str(self).lower()
        return "429" in text or "rate limit" in text or "quota" in text


def openrouter_api_key() -> str:
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def groq_api_key() -> str:
    return os.environ.get("GROQ_API_KEY", "").strip()


def openrouter_base_url() -> str:
    return os.environ.get("OPENROUTER_BASE_URL", "").strip() or OPENROUTER_BASE_URL


def groq_base_url() -> str:
    return os.environ.get("GROQ_BASE_URL", "").strip() or GROQ_BASE_URL


def openrouter_chat_model() -> str:
    return os.environ.get("OPENROUTER_MODEL", "").strip() or DEFAULT_OPENROUTER_CHAT_MODEL


def openrouter_json_model() -> str:
    return (
        os.environ.get("OPENROUTER_JSON_MODEL", "").strip()
        or os.environ.get("OPENROUTER_MODEL", "").strip()
        or DEFAULT_OPENROUTER_JSON_MODEL
    )


# Groq ids are its own namespace ("qwen/qwen3.8-27b"), not OpenRouter's. Without
# separate vars a Groq request carries an OpenRouter id and 404s on a model the
# provider has never heard of.
DEFAULT_GROQ_CHAT_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_JSON_MODEL = "qwen/qwen3.8-27b"


def groq_chat_model() -> str:
    return os.environ.get("GROQ_MODEL", "").strip() or DEFAULT_GROQ_CHAT_MODEL


def groq_json_model() -> str:
    return (
        os.environ.get("GROQ_JSON_MODEL", "").strip()
        or os.environ.get("GROQ_MODEL", "").strip()
        or DEFAULT_GROQ_JSON_MODEL
    )


def default_chat_model_for(provider: str) -> str:
    return groq_chat_model() if provider == "groq" else openrouter_chat_model()


def default_json_model_for(provider: str) -> str:
    return groq_json_model() if provider == "groq" else openrouter_json_model()


def _referer_headers() -> Dict[str, str]:
    """OpenRouter attributes traffic by these. Harmless elsewhere."""
    headers: Dict[str, str] = {}
    app_url = os.environ.get("OPENROUTER_APP_URL", "").strip()
    app_title = os.environ.get("OPENROUTER_APP_TITLE", "").strip() or "MindPal"
    if app_url:
        headers["HTTP-Referer"] = app_url
    headers["X-Title"] = app_title
    return headers


_CLIENT_LOCK = threading.Lock()
_CLIENTS: Dict[tuple, httpx.Client] = {}
_ASYNC_CLIENTS: Dict[tuple, httpx.AsyncClient] = {}


def _client(base_url: str, api_key: str, timeout_s: float) -> httpx.Client:
    """Pooled per (base, key, timeout). A client per call is a TLS handshake per call."""
    key = (base_url, api_key, timeout_s)
    existing = _CLIENTS.get(key)
    if existing is not None:
        return existing
    with _CLIENT_LOCK:
        existing = _CLIENTS.get(key)
        if existing is None:
            existing = httpx.Client(
                base_url=base_url,
                timeout=timeout_s,
                headers={"Authorization": f"Bearer {api_key}", **_referer_headers()},
            )
            _CLIENTS[key] = existing
    return existing


def _async_client(base_url: str, api_key: str, timeout_s: float) -> httpx.AsyncClient:
    key = (base_url, api_key, timeout_s)
    existing = _ASYNC_CLIENTS.get(key)
    if existing is not None:
        return existing
    with _CLIENT_LOCK:
        existing = _ASYNC_CLIENTS.get(key)
        if existing is None:
            existing = httpx.AsyncClient(
                base_url=base_url,
                timeout=timeout_s,
                headers={"Authorization": f"Bearer {api_key}", **_referer_headers()},
            )
            _ASYNC_CLIENTS[key] = existing
    return existing


def reset_openai_clients() -> None:
    """Test helper. Closes and drops pooled clients."""
    with _CLIENT_LOCK:
        for client in _CLIENTS.values():
            try:
                client.close()
            except Exception:
                pass
        _CLIENTS.clear()
        _ASYNC_CLIENTS.clear()
        _NO_REASONING_BASES.clear()


def build_messages(
    prompt: str,
    system_instruction: Optional[str],
    history: Optional[Sequence[Dict[str, str]]],
) -> List[Dict[str, str]]:
    messages: List[Dict[str, str]] = []
    if system_instruction:
        messages.append({"role": "system", "content": system_instruction})
    for turn in history or ():
        role = "user" if turn.get("role") == "user" else "assistant"
        text = str(turn.get("content") or "").strip()
        if text:
            messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": prompt})
    return messages


# Every spelling of "do not reason" we might send, so a retry can strip them all.
REASONING_FIELDS = ("reasoning", "reasoning_effort", "reasoning_format")

# Bases observed to reject the field. Avoids paying a 400 on every later call.
_NO_REASONING_BASES: set = set()


def _remember_no_reasoning(base_url: str) -> None:
    _NO_REASONING_BASES.add(base_url)


def _reasoning_off_payload(base_url: str) -> Dict[str, Any]:
    if base_url in _NO_REASONING_BASES:
        return {}
    if "groq.com" in base_url:
        # Groq's spelling. Supported on its reasoning-capable models; probed
        # rather than assumed for the rest.
        return {"reasoning_effort": "none"}
    return {"reasoning": {"enabled": False}}


def _rejects_reasoning_field(response: httpx.Response) -> bool:
    """True when a 400 names a reasoning field, rather than being a real bug."""
    try:
        body = response.text.lower()
    except Exception:
        return False
    if not any(field in body for field in REASONING_FIELDS):
        return False
    return any(hint in body for hint in ("unsupported", "unknown", "not supported", "invalid"))


def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    body = ""
    try:
        body = response.text[:300]
    except Exception:
        pass
    raise OpenAICompatibleError(
        f"{response.status_code} {response.reason_phrase}: {body}", response.status_code
    )


def complete_json(
    *,
    prompt: str,
    system_instruction: Optional[str] = None,
    model: str = "",
    temperature: float = 0.0,
    max_tokens: int = 128,
    base_url: str = "",
    api_key: str = "",
    timeout_s: float = JSON_TIMEOUT_S,
) -> str:
    """Blocking structured completion. Used by the live-voice crisis classifier."""
    key = api_key or openrouter_api_key()
    if not key:
        raise OpenAICompatibleError("No API key configured for the OpenAI-compatible provider.")
    resolved_base = base_url or openrouter_base_url()
    client = _client(resolved_base, key, timeout_s)
    payload: Dict[str, Any] = {
        "model": model or openrouter_json_model(),
        "messages": build_messages(prompt, system_instruction, None),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    # The analogue of thinking_budget=0 on the Gemini path, and the same failure
    # if omitted: many current models reason by default, the chain eats an
    # 80-token budget, and the classifier returns empty - which the live session
    # records as safety_unverified. A 3-way label needs no chain, and this path
    # has a 600 ms mic-gate budget.
    #
    # The spelling is provider-specific and not every model accepts it, so it is
    # probed rather than assumed: a 400 that names the field is retried without
    # it, the same discipline the Live token mint uses for optional setup fields.
    payload.update(_reasoning_off_payload(resolved_base))

    def _post(body: Dict[str, Any]) -> httpx.Response:
        try:
            return client.post("/chat/completions", json=body)
        except httpx.TimeoutException as exc:
            raise OpenAICompatibleError(f"timeout after {timeout_s}s") from exc
        except httpx.HTTPError as exc:
            raise OpenAICompatibleError(f"transport: {type(exc).__name__}") from exc

    response = _post(payload)
    if response.status_code == 400 and _rejects_reasoning_field(response):
        stripped = {k: v for k, v in payload.items() if k not in REASONING_FIELDS}
        logger.info("llm_reasoning_field_rejected base=%s retrying_without", resolved_base)
        _remember_no_reasoning(resolved_base)
        response = _post(stripped)
    _raise_for_status(response)
    try:
        data = response.json()
    except ValueError as exc:
        raise OpenAICompatibleError("provider returned a non-JSON body") from exc
    return _first_choice_text(data)


def _first_choice_text(data: Dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        # OpenRouter surfaces upstream failures in an `error` object with a 200.
        error = data.get("error")
        if isinstance(error, dict):
            status = int(error.get("code") or 0)
            raise OpenAICompatibleError(str(error.get("message") or "provider error"), status)
        raise OpenAICompatibleError("provider returned no choices")
    message = choices[0].get("message") or {}
    text = message.get("content")
    return text.strip() if isinstance(text, str) else ""


async def stream_text(
    *,
    prompt: str,
    system_instruction: Optional[str] = None,
    model: str = "",
    temperature: float = 0.7,
    max_tokens: int = 1024,
    history: Optional[Sequence[Dict[str, str]]] = None,
    base_url: str = "",
    api_key: str = "",
    timeout_s: float = STREAM_TIMEOUT_S,
) -> AsyncGenerator[str, None]:
    """Server-sent-events chat stream, yielding text deltas."""
    key = api_key or openrouter_api_key()
    if not key:
        raise OpenAICompatibleError("No API key configured for the OpenAI-compatible provider.")
    client = _async_client(base_url or openrouter_base_url(), key, timeout_s)
    payload: Dict[str, Any] = {
        "model": model or openrouter_chat_model(),
        "messages": build_messages(prompt, system_instruction, history),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    try:
        async with client.stream("POST", "/chat/completions", json=payload) as response:
            if response.status_code >= 400:
                await response.aread()
                _raise_for_status(response)
            async for line in response.aiter_lines():
                for delta in parse_sse_line(line):
                    yield delta
    except httpx.TimeoutException as exc:
        raise OpenAICompatibleError(f"timeout after {timeout_s}s") from exc
    except httpx.HTTPError as exc:
        raise OpenAICompatibleError(f"transport: {type(exc).__name__}") from exc


def parse_sse_line(line: str) -> Iterable[str]:
    """Extract text deltas from one SSE line. Pure, so it is unit-testable."""
    text = (line or "").strip()
    if not text or not text.startswith("data:"):
        return ()
    body = text[5:].strip()
    if not body or body == "[DONE]":
        return ()
    try:
        chunk = json.loads(body)
    except ValueError:
        return ()
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return ()
    delta = choices[0].get("delta") or {}
    content = delta.get("content")
    return (content,) if isinstance(content, str) and content else ()
