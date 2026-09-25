"""Reading images: page images in, a strict JSON reading out.

A fallback list of vision-capable models, tried in order
(MINDPAL_VISION_FALLBACK, "provider:model" separated by commas):
Gemini flash-lite is cheap and reads Arabic and handwriting well; Qwen 3.8 on
Groq also takes images and answers fast; Gemma on OpenRouter is a free spare.
Unlike the chat fallback, any failure moves on: a model that rejects an image
(a 400) is exactly the case the next rung is for.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx

from backend.configs.llm import compatible_provider, files_api_key
from backend.configs.settings import get_settings
from backend.infra.llm.thinking import thinking_kwargs
from backend.models.provider_outputs import extract_json_object

logger = logging.getLogger("mindpal.vision")

# Gemini 3.x: the 2.5 models are closed to new projects (a separate files key
# comes from a new project), and every key can use 3.x.
DEFAULT_VISION_LADDER = (
    "gemini:gemini-3.5-flash-lite,groq:qwen/qwen3.8-27b,"
    "gemini:gemini-3.8-flash,openrouter:google/gemma-4-31b-it:free"
)
# Answering about files (writing a reply, not reading a page): the stronger
# writer first. Qwen's Arabic, for one, slipped into typos and repeated words.
DEFAULT_ANSWER_LADDER = (
    "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash-lite,groq:qwen/qwen3.8-27b,"
    "openrouter:google/gemma-4-31b-it:free"
)
TIMEOUT_S = 45.0
_COOLDOWN_S = 30.0
RETRY_WAIT_S = 4.0
_COOLING: Dict[Tuple[str, str], float] = {}


class VisionUnavailable(RuntimeError):
    """No vision model could read the images."""


@dataclass(frozen=True)
class VisionImage:
    data: bytes
    mime_type: str


@dataclass(frozen=True)
class VisionReading:
    data: Dict[str, Any]
    provider: str
    model: str
    ms: int


def vision_ladder() -> List[Tuple[str, str]]:
    """Models that read pages: cheap and fast first."""
    return _parse_ladder((get_settings().vision_fallback or "").strip() or DEFAULT_VISION_LADDER)


def answer_ladder() -> List[Tuple[str, str]]:
    """Models that answer about files and pictures: long context, images, good writing."""
    return _parse_ladder((get_settings().files_chat_fallback or "").strip() or DEFAULT_ANSWER_LADDER)


def _parse_ladder(raw: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    for item in raw.split(","):
        provider, _, model = item.strip().partition(":")
        provider, model = provider.strip().lower(), model.strip()
        if provider and model and (provider, model) not in out and _has_key(provider):
            out.append((provider, model))
    return out


def vision_available() -> bool:
    return bool(vision_ladder())


def _has_key(provider: str) -> bool:
    return bool(files_api_key(provider))


def _ordered(entries: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    now = time.monotonic()
    ready = [e for e in entries if _COOLING.get(e, 0.0) <= now]
    return ready + [e for e in entries if e not in ready]


def _via_gemini(model: str, images: Sequence[VisionImage], instruction: str, max_tokens: int) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=files_api_key("gemini"))
    parts: List[Any] = [types.Part.from_bytes(data=image.data, mime_type=image.mime_type) for image in images]
    parts.append(instruction)
    result = client.models.generate_content(
        model=model,
        contents=parts,
        config=types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
            http_options=types.HttpOptions(timeout=int(TIMEOUT_S * 1000)),
            # Reading needs no reasoning: none on 2.5, the least on 3.x.
            **thinking_kwargs(model, 0),
        ),
    )
    return result.text or ""


def _via_compatible(provider: str, model: str, images: Sequence[VisionImage], instruction: str, max_tokens: int) -> str:
    entry = compatible_provider(provider)
    if entry is None:
        raise VisionUnavailable(f"unknown provider {provider}")
    content: List[Dict[str, Any]] = [{"type": "text", "text": instruction}]
    for image in images:
        encoded = base64.b64encode(image.data).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:{image.mime_type};base64,{encoded}"}})
    response = httpx.post(
        entry.base_url().rstrip("/") + "/chat/completions",
        headers={"Authorization": f"Bearer {files_api_key(provider)}"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        },
        timeout=TIMEOUT_S,
    )
    if response.status_code != 200:
        raise VisionUnavailable(f"{provider} {response.status_code}: {response.text[:160]}")
    choices = response.json().get("choices") or [{}]
    return str((choices[0].get("message") or {}).get("content") or "")


def _rate_limited(text: str) -> bool:
    # Not a bare "rate": that is also in "generate".
    return any(marker in text for marker in ("429", "resource_exhausted", "rate limit", "rate_limit", "ratelimit"))


def read_images(
    images: Sequence[VisionImage],
    instruction: str,
    *,
    max_tokens: int = 4096,
    ladder: Optional[List[Tuple[str, str]]] = None,
) -> VisionReading:
    """First rung that returns parseable JSON wins. Raises VisionUnavailable."""
    if not images:
        raise ValueError("no images")
    entries = _ordered(ladder if ladder is not None else vision_ladder())
    errors: List[str] = []
    for round_ in range(2):
        limited = 0
        for provider, model in entries:
            started = time.monotonic()
            try:
                if provider == "gemini":
                    raw = _via_gemini(model, images, instruction, max_tokens)
                else:
                    raw = _via_compatible(provider, model, images, instruction, max_tokens)
                data = extract_json_object(raw)
                return VisionReading(data=data, provider=provider, model=model, ms=int((time.monotonic() - started) * 1000))
            except Exception as exc:  # any failure: next rung
                text = f"{type(exc).__name__} {exc}".lower()
                if _rate_limited(text):
                    limited += 1
                    _COOLING[(provider, model)] = time.monotonic() + _COOLDOWN_S
                elif "404" in text or "not_found" in text:
                    # A model this key cannot use: skip it for an hour, not every call.
                    _COOLING[(provider, model)] = time.monotonic() + 3600
                errors.append(f"{provider}:{model}: {type(exc).__name__}")
                logger.warning("vision_rung_failed provider=%s model=%s detail=%s", provider, model, str(exc)[:200])
        # Every rung busy at once: per-minute token caps refill within seconds,
        # so one short wait usually beats telling someone to try again.
        if round_ == 0 and entries and limited == len(entries):
            time.sleep(RETRY_WAIT_S)
            continue
        break
    raise VisionUnavailable("; ".join(errors) or "no vision provider configured")
