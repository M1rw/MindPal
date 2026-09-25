# backend/infra/llm/gateway.py — Unified LLM Provider Gateway

from __future__ import annotations

import logging
import threading
import time
from typing import Any, AsyncGenerator, Optional, Sequence

from pydantic import BaseModel, ValidationError
from backend.configs.llm import DEFAULT_GEMINI_CHAT_MODEL, DEFAULT_GEMINI_JSON_MODEL
from backend.configs.settings import get_settings
from backend.infra.observability.metrics import ProviderMetric, elapsed_ms, provider_metrics
logger = logging.getLogger("mindpal.llm")

_FALLBACK_STUB = "I'm here with you. What's on your mind?"

DEFAULT_CHAT_MODEL = DEFAULT_GEMINI_CHAT_MODEL

# Classifier-class work (3-way label, temperature 0) does not need Flash. Lite is
# materially cheaper and faster, and classify latency is time the live-voice mic
# is gated, so this is a user-visible latency budget, not just a bill.
#
# It is also a separate quota pool, which matters: when the chat model's quota is
# exhausted the classifier keeps working instead of taking 429s and recording
# safety_unverified on every live call.
#
# Both are env-overridable. GEMINI_JSON_MODEL exists specifically so the safety
# classifier can be moved back to a stronger model without a deploy if
# scripts/eval/validate_voice_classifier.py shows the cheaper one mislabelling.
JSON_MODEL = DEFAULT_GEMINI_JSON_MODEL


_ANNOUNCED: set[str] = set()


def _announce(var: str, chosen: str, fallback: str) -> str:
    """Say out loud when an env var overrides a model.

    GEMINI_MODEL sat unread in .env files for long enough that the values in them
    went stale. Now that it is honoured, a forgotten line silently changes which
    model answers users — so the override is logged the first time it is used.
    """
    if chosen != fallback and var not in _ANNOUNCED:
        _ANNOUNCED.add(var)
        logger.warning(
            "llm_model_override var=%s using=%s instead_of=%s", var, chosen, fallback
        )
    return chosen


def default_chat_model() -> str:
    chosen = get_settings().gemini_model.strip() or DEFAULT_CHAT_MODEL
    return _announce("GEMINI_MODEL", chosen, DEFAULT_CHAT_MODEL)


def json_model() -> str:
    chosen = get_settings().gemini_json_model.strip() or JSON_MODEL
    return _announce("GEMINI_JSON_MODEL", chosen, JSON_MODEL)


# --- Provider routing ---------------------------------------------------------
#
# Gemini's quota is one pool, and the only workload that genuinely requires Gemini
# is the Live native-audio socket. Chat, the crisis classifier and the call recap
# are ordinary text. Routing those elsewhere keeps the whole Gemini allocation for
# Live, and stops a text-quota exhaustion from taking the live-voice safety
# classifier down with it.
#
# MINDPAL_LLM_PROVIDER      default for every text path: gemini or any provider
#                           in backend/configs/llm.py COMPATIBLE_PROVIDERS
# MINDPAL_CHAT_PROVIDER     override for chat streaming
# MINDPAL_JSON_PROVIDER     override for the classifier / structured calls
# MINDPAL_LLM_FALLBACK      the ladder: comma-separated "provider" or
#                           "provider:model" entries tried in order when the one
#                           before rate-limits or fails before its first token,
#                           e.g. "groq:openai/gpt-oss-120b,openrouter,gemini".
#                           Free tiers limit per key and (on Groq) per model, so a
#                           second model on the same key is real extra capacity.
from backend.configs.llm import COMPATIBLE_PROVIDERS, compatible_provider  # noqa: E402

PROVIDERS = ("gemini", *COMPATIBLE_PROVIDERS)
LadderEntry = tuple[str, Optional[str]]  # (provider, model; None = that provider's default)


def _provider(var: str, default: str = "") -> str:
    value = get_settings().provider_override(var)
    if value and value not in PROVIDERS:
        logger.warning("llm_provider_unknown var=%s value=%s falling_back=gemini", var, value)
        return ""
    return value


def chat_provider() -> str:
    return _provider("MINDPAL_CHAT_PROVIDER") or _provider("MINDPAL_LLM_PROVIDER") or "gemini"


def structured_provider() -> str:
    return _provider("MINDPAL_JSON_PROVIDER") or _provider("MINDPAL_LLM_PROVIDER") or "gemini"


def fallback_ladder() -> list[LadderEntry]:
    """The configured spares, in order. Model ids keep their case (and colons)."""
    entries: list[LadderEntry] = []
    for raw in get_settings().llm_fallback.split(","):
        name, _, model = raw.strip().partition(":")
        name = name.strip().lower()
        if not name:
            continue
        if name not in PROVIDERS:
            logger.warning("llm_fallback_unknown entry=%s", raw.strip())
            continue
        entries.append((name, model.strip() or None))
    return entries


def fallback_provider() -> str:
    """The first spare's provider ("" when there is no ladder)."""
    ladder = fallback_ladder()
    return ladder[0][0] if ladder else ""


def _has_credentials(provider: str) -> bool:
    if provider == "gemini":
        return bool(_api_key())
    entry = compatible_provider(provider)
    return bool(entry and entry.api_key())


def _openai_compatible_config(provider: str) -> tuple[str, str]:
    """(base_url, api_key) for an OpenAI-shaped provider."""
    entry = compatible_provider(provider) or COMPATIBLE_PROVIDERS["openrouter"]
    return entry.base_url(), entry.api_key()


# A spare that just rate-limited is tried last for a short while instead of first:
# under load every request otherwise pays a wasted round trip to a full bucket.
_COOLDOWN_S = 20.0
_COOLING: dict[LadderEntry, float] = {}


def _cool(entry: LadderEntry) -> None:
    _COOLING[entry] = time.monotonic() + _COOLDOWN_S


def _reset_cooldowns() -> None:
    _COOLING.clear()


def _ordered(entries: list[LadderEntry]) -> list[LadderEntry]:
    now = time.monotonic()
    ready = [e for e in entries if _COOLING.get(e, 0.0) <= now]
    return ready + [e for e in entries if e not in ready]


def _ladder(primary: LadderEntry) -> list[LadderEntry]:
    """Primary first, then the spares; each entry once, only providers with a key."""
    out: list[LadderEntry] = []
    for entry in [primary, *fallback_ladder()]:
        if entry not in out and _has_credentials(entry[0]):
            out.append(entry)
    return out


def _is_rate_limited(exc: BaseException) -> bool:
    from backend.infra.llm.openrouter import OpenAICompatibleError

    if isinstance(exc, OpenAICompatibleError):
        return exc.is_rate_limited
    text = f"{type(exc).__name__} {exc}".lower()
    return "429" in text or "resource_exhausted" in text or "rate limit" in text


def _is_transient(exc: BaseException) -> bool:
    """Worth trying the next rung: rate limits, 5xx, timeouts, a dropped connection, no reply.

    A 4xx other than 429 is a bug to surface, not a reason to shop providers.
    """
    import httpx

    from backend.infra.llm.openrouter import OpenAICompatibleError

    if _is_rate_limited(exc):
        return True
    if isinstance(exc, OpenAICompatibleError):
        return exc.status == 0 or exc.status >= 500
    if isinstance(exc, (httpx.TransportError, TimeoutError, LLMGatewayError)):
        return True
    text = f"{type(exc).__name__} {exc}".lower()
    return any(k in text for k in ("503", "502", "504", "500 ", "overloaded", "unavailable", "timeout", "deadline"))


def _model_for_provider(provider: str, model: Optional[str], default_model: str) -> Optional[str]:
    """Use provider-native defaults instead of sending a Gemini id elsewhere."""
    if provider != "gemini" and (
        not model or model == default_model or model.startswith("gemini-")
    ):
        return None
    return model

# 2.5 models think by default and thinking tokens are billed as output AND counted
# against max_output_tokens. A classifier capped at 80 tokens can spend all of them
# thinking and return empty text (finish_reason MAX_TOKENS), which this gateway then
# raises as "unavailable" -> the live-voice verdict becomes unverified. Structured
# short-output calls therefore pin thinking to zero. Chat keeps provider defaults.
JSON_THINKING_BUDGET = 0

# A hung provider call is worse than a failed one on the live-voice path: upstream
# PCM is gated while a classify request is in flight. Fail fast instead, but no
# faster than Gemini accepts: it rejects any deadline under 10s with a 400, which
# failed every Gemini JSON call (classifier included) before it was sent.
JSON_TIMEOUT_MS = 10_000
STREAM_TIMEOUT_MS = 60_000


_CLIENT_LOCK = threading.Lock()
_CLIENTS: dict[tuple[str, int], Any] = {}


def _api_key() -> str:
    return get_settings().resolved_gemini_api_key()


def _get_client(api_key: str, *, timeout_ms: int) -> Any:
    """One client per (key, timeout). Rebuilding per call cost a TLS handshake
    and a fresh connection pool on every classify — pure latency on a path that
    mutes the microphone while it runs."""
    cache_key = (api_key, timeout_ms)
    client = _CLIENTS.get(cache_key)
    if client is not None:
        return client
    from google import genai
    from google.genai import types

    with _CLIENT_LOCK:
        client = _CLIENTS.get(cache_key)
        if client is None:
            client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(timeout=timeout_ms),
            )
            _CLIENTS[cache_key] = client
    return client


def reset_llm_clients() -> None:
    """Test helper. Drops cached clients so a key change is picked up."""
    with _CLIENT_LOCK:
        _CLIENTS.clear()


def _thinking_kwargs(budget: Optional[int]) -> dict[str, Any]:
    """Build the thinking config, tolerating SDKs/models that do not expose it.

    A model without a thinking knob must not turn into a hard failure on the
    live-voice safety path, so an unsupported SDK degrades to provider default
    rather than raising.
    """
    if budget is None:
        return {}
    try:
        from google.genai import types

        return {"thinking_config": types.ThinkingConfig(thinking_budget=int(budget))}
    except Exception:  # pragma: no cover - SDK without ThinkingConfig
        logger.info("llm_thinking_config_unsupported budget=%s", budget)
        return {}


def _finish_reason(response: Any) -> str:
    try:
        return str(response.candidates[0].finish_reason)
    except Exception:
        return "unknown"


def _thoughts_tokens(response: Any) -> int:
    try:
        return int(getattr(response.usage_metadata, "thoughts_token_count", 0) or 0)
    except Exception:
        return 0


class LLMGatewayError(Exception):
    """Provider failure surfaced as a structured chat error, not a fake reply."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


class LLMGateway:
    """Unified LLM execution gateway (Gemini via google-genai, or local stub)."""

    def __init__(self, default_model: str = "") -> None:
        # Empty means "read GEMINI_MODEL". The env var existed but nothing read
        # it, so the model was effectively hardcoded.
        self.default_model = default_model or default_chat_model()

    def _build_contents(
        self, prompt: str, history: Sequence[dict[str, str]] | None, images: Sequence[Any] | None = None
    ) -> list[Any]:
        from google.genai import types

        contents: list[Any] = []
        for turn in history or ():
            role = "user" if turn.get("role") == "user" else "model"
            text = str(turn.get("content") or "").strip()
            if not text:
                continue
            contents.append(types.Content(role=role, parts=[types.Part(text=text)]))
        # Images for this turn ride with the latest message, before its words.
        parts = [types.Part.from_bytes(data=image.data, mime_type=image.mime_type) for image in images or ()]
        contents.append(types.Content(role="user", parts=[*parts, types.Part(text=prompt)]))
        return contents

    async def generate(
        self,
        *,
        prompt: str,
        system_instruction: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        history: Optional[Sequence[dict[str, str]]] = None,
        thinking_budget: Optional[int] = None,
        images: Optional[Sequence[Any]] = None,
        long_context: bool = False,
    ) -> str:
        parts: list[str] = []
        async for token in self.generate_stream(
            prompt=prompt,
            system_instruction=system_instruction,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            history=history,
            thinking_budget=thinking_budget,
            images=images,
            long_context=long_context,
        ):
            parts.append(token)
        text = "".join(parts).strip()
        if not text:
            raise LLMGatewayError(
                "unavailable",
                "MindPal didn't receive a reply. Please retry this message.",
            )
        return text

    async def generate_stream(
        self,
        *,
        prompt: str,
        system_instruction: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        history: Optional[Sequence[dict[str, str]]] = None,
        thinking_budget: Optional[int] = None,
        images: Optional[Sequence[Any]] = None,
        long_context: bool = False,
    ) -> AsyncGenerator[str, None]:
        """`images` (VisionImage) or `long_context` (a turn carrying documents) use the
        files answer models (MINDPAL_FILES_CHAT_FALLBACK): they see images, have room
        for pages of text (the small fast chat models cap tokens per minute), and
        write better in every language."""
        if images or long_context:
            from backend.infra.llm.vision import answer_ladder

            ladder = answer_ladder()
        else:
            primary = chat_provider()
            primary_model = (model or self.default_model) if primary == "gemini" else _model_for_provider(primary, model, self.default_model)
            ladder = _ladder((primary, primary_model))
        if not ladder:
            logger.info("llm_fallback_no_credentials provider=%s", primary)
            yield _FALLBACK_STUB
            return

        last_error: Optional[BaseException] = None
        ordered = _ordered(ladder)
        for index, entry in enumerate(ordered):
            provider, entry_model = entry
            if index:
                logger.warning(
                    "llm_chat_fallback to=%s model=%s reason=%s",
                    provider,
                    entry_model or "default",
                    "rate_limited" if last_error is not None and _is_rate_limited(last_error) else "failed",
                )
            yielded = False
            try:
                if provider == "gemini":
                    stream = self._stream_gemini(
                        model=entry_model or self.default_model,
                        prompt=prompt,
                        system_instruction=system_instruction,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        history=history,
                        thinking_budget=thinking_budget,
                        images=images,
                    )
                else:
                    stream = self._stream_openai_compatible(
                        provider,
                        prompt=prompt,
                        system_instruction=system_instruction,
                        model=entry_model,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        history=history,
                        fallback=bool(index),
                        images=images,
                    )
                async for token in stream:
                    yielded = True
                    yield token
                if yielded:
                    return
                raise LLMGatewayError("unavailable", "MindPal didn't receive a reply. Please retry this message.")
            except Exception as exc:
                logger.warning(
                    "llm_provider_failed provider=%s error_type=%s detail=%s",
                    provider,
                    type(exc).__name__,
                    str(exc)[:180],
                )
                # Mid-stream failure: the user already has partial text on screen.
                # Restarting on another provider would repeat or contradict it.
                if yielded:
                    raise LLMGatewayError(
                        "unavailable",
                        "MindPal lost the connection partway through this response. Please retry.",
                    ) from exc
                if _is_rate_limited(exc):
                    _cool(entry)
                last_error = exc
                if not (images or long_context) and not _is_transient(exc):
                    break
        if isinstance(last_error, LLMGatewayError):
            raise last_error
        raise LLMGatewayError(
            "unavailable",
            "MindPal hit a connection issue while generating this response. Please retry this message.",
        ) from last_error

    async def _stream_gemini(
        self,
        *,
        model: str,
        prompt: str,
        system_instruction: Optional[str],
        temperature: float,
        max_tokens: int,
        history: Optional[Sequence[dict[str, str]]],
        thinking_budget: Optional[int],
        images: Optional[Sequence[Any]] = None,
    ) -> AsyncGenerator[str, None]:
        """One Gemini stream. Provider errors propagate as-is so the ladder can read them."""
        started = time.perf_counter()
        yielded = False
        prompt_tokens = 0
        completion_tokens = 0
        try:
            from google.genai import types

            client = _get_client(_api_key(), timeout_ms=STREAM_TIMEOUT_MS)
            config = types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=temperature,
                max_output_tokens=max_tokens,
                **_thinking_kwargs(thinking_budget),
            )
            stream = await client.aio.models.generate_content_stream(
                model=model,
                contents=self._build_contents(prompt, history, images),
                config=config,
            )
            async for chunk in stream:
                text = getattr(chunk, "text", None) or ""
                usage = getattr(chunk, "usage_metadata", None)
                prompt_tokens = int(getattr(usage, "prompt_token_count", prompt_tokens) or prompt_tokens)
                completion_tokens = int(getattr(usage, "candidates_token_count", completion_tokens) or completion_tokens)
                if text:
                    yielded = True
                    yield text
        except Exception as exc:
            provider_metrics().record(
                ProviderMetric("gemini", "stream", elapsed_ms(started), False, rate_limited=_is_rate_limited(exc))
            )
            raise
        provider_metrics().record(
            ProviderMetric("gemini", "stream", elapsed_ms(started), yielded, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
        )

    async def _stream_openai_compatible(
        self,
        provider: str,
        *,
        prompt: str,
        system_instruction: Optional[str],
        model: Optional[str],
        temperature: float,
        max_tokens: int,
        history: Optional[Sequence[dict[str, str]]],
        fallback: bool = False,
        images: Optional[Sequence[Any]] = None,
    ) -> AsyncGenerator[str, None]:
        from backend.infra.llm import openrouter as oai

        base_url, key = _openai_compatible_config(provider)
        if not key:
            raise LLMGatewayError("unavailable", f"{provider} is not configured.")
        started = time.perf_counter()
        yielded = False
        try:
            async for token in oai.stream_text(
                prompt=prompt,
                system_instruction=system_instruction,
                model=model or oai.default_chat_model_for(provider),
                temperature=temperature,
                max_tokens=max_tokens,
                history=history,
                base_url=base_url,
                api_key=key,
                images=images,
            ):
                yielded = True
                yield token
        except Exception as exc:
            provider_metrics().record(
                ProviderMetric(
                    provider, "stream", elapsed_ms(started), False,
                    fallback=fallback, retries=1 if fallback else 0, rate_limited=_is_rate_limited(exc),
                )
            )
            raise
        provider_metrics().record(
            ProviderMetric(provider, "stream", elapsed_ms(started), yielded, fallback=fallback, retries=1 if fallback else 0)
        )

    def generate_json(
        self,
        *,
        prompt: str,
        system_instruction: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 128,
        thinking_budget: Optional[int] = None,
    ) -> str:
        """Synchronous JSON completion. Fail closed — never invent a stub classifier label."""
        primary = structured_provider()
        # Spares use their provider's JSON model, never a chat model named in the
        # ladder: the classifier only runs on models validated for it
        # (scripts/eval/validate_voice_classifier.py), and a reasoning chat
        # model spends a small token budget thinking and returns no JSON.
        spares = [(provider, None) for provider, _ in fallback_ladder()]
        candidates: list[LadderEntry] = []
        for entry in [(primary, model or None), *spares]:
            if entry not in candidates and _has_credentials(entry[0]):
                candidates.append(entry)
        entries = _ordered(candidates) or [(primary, model or None)]
        # Structured calls gate the live-voice microphone: two attempts at most,
        # so a bad minute cannot stall a call behind the whole ladder.
        entries = entries[:2]
        last_error: Optional[BaseException] = None
        for index, entry in enumerate(entries):
            provider, entry_model = entry
            if index:
                logger.warning("llm_json_fallback to=%s model=%s", provider, entry_model or "default")
            started = time.perf_counter()
            try:
                result = self._generate_json_via(
                    provider,
                    prompt=prompt,
                    system_instruction=system_instruction,
                    model=entry_model or "",
                    temperature=temperature,
                    max_tokens=max_tokens,
                    thinking_budget=thinking_budget,
                )
            except Exception as exc:
                provider_metrics().record(
                    ProviderMetric(
                        provider, "structured", elapsed_ms(started), False,
                        rate_limited=_is_rate_limited(exc), fallback=bool(index), retries=index,
                    )
                )
                if _is_rate_limited(exc):
                    _cool(entry)
                last_error = exc
                if not _is_transient(exc):
                    raise
                continue
            provider_metrics().record(
                ProviderMetric(provider, "structured", elapsed_ms(started), True, fallback=bool(index), retries=index)
            )
            return result
        assert last_error is not None
        raise last_error

    def generate_structured(
        self,
        *,
        contract: type[BaseModel],
        **kwargs: Any,
    ) -> BaseModel:
        """Generate JSON and validate it against a strict Pydantic contract."""
        raw = self.generate_json(**kwargs)
        try:
            from backend.models.provider_outputs import parse_provider_output

            return parse_provider_output(contract, raw)
        except (ValidationError, ValueError) as exc:
            provider_metrics().record(
                ProviderMetric(
                    structured_provider(),
                    "structured_contract",
                    0,
                    False,
                )
            )
            logger.warning(
                "llm_structured_contract_failed contract=%s error_count=%s",
                contract.__name__,
                len(exc.errors()) if isinstance(exc, ValidationError) else 1,
            )
            raise LLMGatewayError(
                "invalid_provider_output",
                "The model returned an invalid structured response.",
            ) from exc

    def _generate_json_via(
        self,
        provider: str,
        *,
        prompt: str,
        system_instruction: Optional[str],
        model: Optional[str],
        temperature: float,
        max_tokens: int,
        thinking_budget: Optional[int],
    ) -> str:
        if provider != "gemini":
            from backend.infra.llm import openrouter as oai

            base_url, api_key = _openai_compatible_config(provider)
            if not api_key:
                raise LLMGatewayError(
                    "unavailable",
                    "The live-voice safety classifier is not configured.",
                )
            try:
                text = oai.complete_json(
                    prompt=prompt,
                    system_instruction=system_instruction,
                    # Each provider has its own id namespace; an explicit model
                    # only applies to the provider it was written for.
                    model=model or oai.default_json_model_for(provider),
                    temperature=temperature,
                    max_tokens=max_tokens,
                    base_url=base_url,
                    api_key=api_key,
                )
            except oai.OpenAICompatibleError:
                raise
            except Exception as exc:
                raise LLMGatewayError("unavailable", "The classifier call failed.") from exc
            if not text:
                raise LLMGatewayError(
                    "unavailable",
                    "The live-voice safety classifier returned an empty response.",
                )
            return text

        api_key = _api_key()
        if not api_key:
            raise LLMGatewayError(
                "unavailable",
                "The live-voice safety classifier is not configured.",
            )
        try:
            from google.genai import types

            client = _get_client(api_key, timeout_ms=JSON_TIMEOUT_MS)
            config = types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=temperature,
                max_output_tokens=max_tokens,
                response_mime_type="application/json",
                **_thinking_kwargs(
                    JSON_THINKING_BUDGET if thinking_budget is None else thinking_budget
                ),
            )
            response = client.models.generate_content(
                model=model or json_model(),
                contents=self._build_contents(prompt, None),
                config=config,
            )
            text = (getattr(response, "text", None) or "").strip()
            if not text:
                # Almost always MAX_TOKENS burned on thinking. Say so in the log so
                # this cannot silently regress into a permanently unverified call.
                logger.warning(
                    "llm_json_empty finish_reason=%s thoughts=%s",
                    _finish_reason(response),
                    _thoughts_tokens(response),
                )
                raise LLMGatewayError(
                    "unavailable",
                    "The live-voice safety classifier returned an empty response.",
                )
            return text
        except LLMGatewayError:
            raise
        except Exception as exc:
            logger.warning(
                "llm_json_provider_failed error_type=%s detail=%s",
                type(exc).__name__,
                str(exc)[:180],
            )
            raise LLMGatewayError(
                "unavailable",
                "The live-voice safety classifier could not run.",
            ) from exc


_GLOBAL_LLM = LLMGateway()


def get_llm_gateway() -> LLMGateway:
    return _GLOBAL_LLM
