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
# MINDPAL_LLM_PROVIDER      default for every text path: gemini | openrouter | groq
# MINDPAL_CHAT_PROVIDER     override for chat streaming
# MINDPAL_JSON_PROVIDER     override for the classifier / structured calls
# MINDPAL_LLM_FALLBACK      provider to retry on once, when the primary rate-limits
PROVIDERS = ("gemini", "openrouter", "groq")


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


def fallback_provider() -> str:
    """Tried once when the primary rate-limits. Empty disables the ladder."""
    return _provider("MINDPAL_LLM_FALLBACK")


def _openai_compatible_config(provider: str) -> tuple[str, str]:
    """(base_url, api_key) for an OpenAI-shaped provider."""
    from backend.infra.llm import openrouter as oai

    if provider == "groq":
        return oai.groq_base_url(), oai.groq_api_key()
    return oai.openrouter_base_url(), oai.openrouter_api_key()


def _is_rate_limited(exc: BaseException) -> bool:
    from backend.infra.llm.openrouter import OpenAICompatibleError

    if isinstance(exc, OpenAICompatibleError):
        return exc.is_rate_limited
    text = f"{type(exc).__name__} {exc}".lower()
    return "429" in text or "resource_exhausted" in text or "rate limit" in text


def _model_for_provider(provider: str, model: Optional[str], default_model: str) -> Optional[str]:
    """Use provider-native defaults instead of sending a Gemini id elsewhere."""
    if provider in {"openrouter", "groq"} and (
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
# PCM is gated while a classify request is in flight. Fail fast instead.
JSON_TIMEOUT_MS = 6_000
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

    def _build_contents(self, prompt: str, history: Sequence[dict[str, str]] | None) -> list[Any]:
        from google.genai import types

        contents: list[Any] = []
        for turn in history or ():
            role = "user" if turn.get("role") == "user" else "model"
            text = str(turn.get("content") or "").strip()
            if not text:
                continue
            contents.append(types.Content(role=role, parts=[types.Part(text=text)]))
        contents.append(types.Content(role="user", parts=[types.Part(text=prompt)]))
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
    ) -> AsyncGenerator[str, None]:
        provider = chat_provider()
        if provider in {"openrouter", "groq"}:
            _, key = _openai_compatible_config(provider)
            if not key:
                logger.info("llm_fallback_no_credentials provider=%s", provider)
                yield _FALLBACK_STUB
                return
            yielded = False
            try:
                async for token in self._stream_openai_compatible(
                    provider,
                    prompt=prompt,
                    system_instruction=system_instruction,
                    model=_model_for_provider(provider, model, self.default_model),
                    temperature=temperature,
                    max_tokens=max_tokens,
                    history=history,
                ):
                    yielded = True
                    yield token
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
                spare = fallback_provider()
                if spare and spare != provider and _is_rate_limited(exc):
                    logger.warning(
                        "llm_chat_fallback primary=%s fallback=%s reason=rate_limited",
                        provider,
                        spare,
                    )
                    async for token in self._stream_openai_compatible(
                        spare,
                        prompt=prompt,
                        system_instruction=system_instruction,
                        model=None,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        history=history,
                        fallback=True,
                    ):
                        yielded = True
                        yield token
                    if yielded:
                        return
                raise LLMGatewayError(
                    "unavailable",
                    "MindPal hit a connection issue while generating this response. Please retry this message.",
                ) from exc
            if not yielded:
                raise LLMGatewayError(
                    "unavailable",
                    "MindPal didn't receive a reply. Please retry this message.",
                )
            return

        api_key = _api_key()
        if not api_key:
            logger.info("llm_fallback_no_credentials")
            yield _FALLBACK_STUB
            return

        started = time.perf_counter()
        yielded = False
        prompt_tokens = 0
        completion_tokens = 0
        try:
            from google.genai import types

            client = _get_client(api_key, timeout_ms=STREAM_TIMEOUT_MS)
            config = types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=temperature,
                max_output_tokens=max_tokens,
                **_thinking_kwargs(thinking_budget),
            )
            stream = await client.aio.models.generate_content_stream(
                model=model or self.default_model,
                contents=self._build_contents(prompt, history),
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
            if not yielded:
                raise LLMGatewayError(
                    "unavailable",
                    "MindPal didn't receive a reply. Please retry this message.",
                )
            provider_metrics().record(
                ProviderMetric("gemini", "stream", elapsed_ms(started), True, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
            )
        except LLMGatewayError:
            provider_metrics().record(
                ProviderMetric("gemini", "stream", elapsed_ms(started), False)
            )
            raise
        except Exception as exc:
            provider_metrics().record(
                ProviderMetric("gemini", "stream", elapsed_ms(started), False, rate_limited=_is_rate_limited(exc))
            )
            logger.warning("llm_provider_failed error_type=%s detail=%s", type(exc).__name__, str(exc)[:180])
            raise LLMGatewayError(
                "unavailable",
                "MindPal hit a connection issue while generating this response. Please retry this message.",
            ) from exc

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
            ):
                yielded = True
                yield token
        except Exception:
            provider_metrics().record(
                ProviderMetric(provider, "stream", elapsed_ms(started), False, fallback=fallback, retries=1 if fallback else 0)
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
        started = time.perf_counter()
        try:
            result = self._generate_json_via(
                primary,
                prompt=prompt,
                system_instruction=system_instruction,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking_budget=thinking_budget,
            )
            provider_metrics().record(ProviderMetric(primary, "structured", elapsed_ms(started), True))
            return result
        except Exception as exc:
            provider_metrics().record(
                ProviderMetric(primary, "structured", elapsed_ms(started), False, rate_limited=_is_rate_limited(exc))
            )
            spare = fallback_provider()
            if not spare or spare == primary or not _is_rate_limited(exc):
                raise
            # A rate-limited primary is exactly the case this ladder exists for:
            # an unclassified live call is worse than a slightly weaker label.
            logger.warning(
                "llm_json_fallback primary=%s fallback=%s reason=rate_limited", primary, spare
            )
            fallback_started = time.perf_counter()
            try:
                result = self._generate_json_via(
                    spare,
                    prompt=prompt,
                    system_instruction=system_instruction,
                    model="",
                    temperature=temperature,
                    max_tokens=max_tokens,
                    thinking_budget=thinking_budget,
                )
            except Exception:
                provider_metrics().record(ProviderMetric(spare, "structured", elapsed_ms(fallback_started), False, fallback=True, retries=1))
                raise
            provider_metrics().record(ProviderMetric(spare, "structured", elapsed_ms(fallback_started), True, fallback=True, retries=1))
            return result

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
        if provider in {"openrouter", "groq"}:
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
