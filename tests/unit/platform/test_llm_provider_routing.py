# tests/unit/platform/test_llm_provider_routing.py — multi-provider text routing
#
# The point of this seam: Gemini's quota is one pool, and the only workload that
# genuinely needs Gemini is the Live native-audio socket. Chat, the crisis
# classifier and the call recap are ordinary text. When the text quota was
# exhausted it took the live-voice safety classifier down with it and the client
# recorded safety_unverified on every call. Routing text elsewhere keeps the
# whole Gemini allocation for Live.
#
# What these pin:
#   - default stays gemini, so this is opt-in and cannot change behaviour silently
#   - each path is independently routable
#   - the fallback ladder fires on rate limits ONLY, never on a real error
#   - a mid-stream failure never restarts on another provider (the user already
#     has partial text on screen)

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import pytest

from backend.infra.llm import gateway as gateway_mod
from backend.infra.llm import openrouter as oai
from backend.infra.llm.gateway import (
    LLMGateway,
    LLMGatewayError,
    chat_provider,
    fallback_provider,
    structured_provider,
)
from backend.infra.llm.openrouter import (
    OpenAICompatibleError,
    build_messages,
    parse_sse_line,
)

PROVIDER_VARS = (
    "MINDPAL_LLM_PROVIDER",
    "MINDPAL_CHAT_PROVIDER",
    "MINDPAL_JSON_PROVIDER",
    "MINDPAL_LLM_FALLBACK",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch):
    for var in PROVIDER_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-or-key")
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    gateway_mod.reset_llm_clients()
    oai.reset_openai_clients()
    yield
    gateway_mod.reset_llm_clients()
    oai.reset_openai_clients()


# --- Routing defaults ----------------------------------------------------------


def test_default_provider_is_gemini_so_nothing_changes_silently() -> None:
    assert chat_provider() == "gemini"
    assert structured_provider() == "gemini"
    assert fallback_provider() == ""


def test_each_path_routes_independently(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINDPAL_LLM_PROVIDER", "openrouter")
    assert chat_provider() == "openrouter"
    assert structured_provider() == "openrouter"

    # The classifier can stay on a different provider from chat: it is the
    # safety path and it is the one with a latency budget.
    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "gemini")
    assert structured_provider() == "gemini"
    assert chat_provider() == "openrouter"


def test_unknown_provider_falls_back_to_gemini_rather_than_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MINDPAL_LLM_PROVIDER", "not-a-provider")
    assert chat_provider() == "gemini"
    assert structured_provider() == "gemini"


# --- Transport helpers ---------------------------------------------------------


def test_sse_parsing_handles_the_real_stream_shapes() -> None:
    assert list(parse_sse_line('data: {"choices":[{"delta":{"content":"hi"}}]}')) == ["hi"]
    assert list(parse_sse_line("data: [DONE]")) == []
    assert list(parse_sse_line(": keep-alive")) == []
    assert list(parse_sse_line("")) == []
    assert list(parse_sse_line("data: not json")) == []
    # A role-only opening delta carries no text.
    assert list(parse_sse_line('data: {"choices":[{"delta":{"role":"assistant"}}]}')) == []


def test_messages_keep_system_first_and_prompt_last() -> None:
    messages = build_messages(
        "how are you",
        "you are MindPal",
        [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    )
    assert messages[0] == {"role": "system", "content": "you are MindPal"}
    assert messages[-1] == {"role": "user", "content": "how are you"}
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]


def test_rate_limit_detection_is_status_first_not_string_matching() -> None:
    assert OpenAICompatibleError("slow down", 429).is_rate_limited is True
    assert OpenAICompatibleError("quota exceeded").is_rate_limited is True
    assert OpenAICompatibleError("bad request", 400).is_rate_limited is False


def test_error_object_returned_with_http_200_is_still_an_error() -> None:
    # OpenRouter surfaces upstream failures in an `error` object on a 200.
    with pytest.raises(OpenAICompatibleError) as excinfo:
        oai._first_choice_text({"error": {"message": "upstream 429", "code": 429}})
    assert excinfo.value.is_rate_limited is True


# --- generate_json routing -----------------------------------------------------


def test_json_goes_to_openrouter_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: Dict[str, Any] = {}

    def fake_complete(**kwargs: Any) -> str:
        seen.update(kwargs)
        return '{"label": "not_crisis"}'

    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "openrouter")
    monkeypatch.setattr(oai, "complete_json", fake_complete)

    out = LLMGateway().generate_json(prompt="User: hi", system_instruction="sys", max_tokens=80)
    assert out == '{"label": "not_crisis"}'
    assert seen["api_key"] == "test-or-key"
    assert "openrouter.ai" in seen["base_url"]
    assert seen["max_tokens"] == 80
    assert seen["temperature"] == 0.0


def test_groq_uses_its_own_base_url_and_key(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: Dict[str, Any] = {}
    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "groq")
    monkeypatch.setattr(oai, "complete_json", lambda **kw: seen.update(kw) or '{"label":"x"}')
    LLMGateway().generate_json(prompt="User: hi")
    assert "groq.com" in seen["base_url"]
    assert seen["api_key"] == "test-groq-key"


def test_empty_label_from_a_provider_is_an_error_not_a_verdict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "openrouter")
    monkeypatch.setattr(oai, "complete_json", lambda **kw: "")
    with pytest.raises(LLMGatewayError):
        LLMGateway().generate_json(prompt="User: hi")


def test_rate_limited_primary_falls_back_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: List[str] = []

    def fake_complete(**kwargs: Any) -> str:
        calls.append(kwargs["base_url"])
        if "openrouter" in kwargs["base_url"]:
            raise OpenAICompatibleError("rate limited", 429)
        return '{"label": "not_crisis"}'

    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "openrouter")
    monkeypatch.setenv("MINDPAL_LLM_FALLBACK", "groq")
    monkeypatch.setattr(oai, "complete_json", fake_complete)

    out = LLMGateway().generate_json(prompt="User: hi")
    assert out == '{"label": "not_crisis"}'
    assert len(calls) == 2, "primary then fallback"
    assert "groq.com" in calls[1]


def test_a_real_error_does_not_trigger_the_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: List[str] = []

    def fake_complete(**kwargs: Any) -> str:
        calls.append(kwargs["base_url"])
        raise OpenAICompatibleError("bad request", 400)

    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "openrouter")
    monkeypatch.setenv("MINDPAL_LLM_FALLBACK", "groq")
    monkeypatch.setattr(oai, "complete_json", fake_complete)

    with pytest.raises(OpenAICompatibleError):
        LLMGateway().generate_json(prompt="User: hi")
    assert len(calls) == 1, "a 400 is a bug to surface, not a reason to shop providers"


# --- generate_stream routing ---------------------------------------------------


def _drain(agen) -> List[str]:
    async def run() -> List[str]:
        return [token async for token in agen]

    return asyncio.run(run())


def test_chat_streams_from_openrouter_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_stream(**kwargs: Any):
        assert "openrouter.ai" in kwargs["base_url"]
        for token in ("Hel", "lo", " there"):
            yield token

    monkeypatch.setenv("MINDPAL_CHAT_PROVIDER", "openrouter")
    monkeypatch.setattr(oai, "stream_text", fake_stream)

    tokens = _drain(LLMGateway().generate_stream(prompt="hi"))
    assert "".join(tokens) == "Hello there"


def test_rate_limited_chat_falls_back_before_any_token(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: List[str] = []

    async def fake_stream(**kwargs: Any):
        seen.append(kwargs["base_url"])
        if "openrouter" in kwargs["base_url"]:
            raise OpenAICompatibleError("rate limited", 429)
            yield  # pragma: no cover
        for token in ("ok",):
            yield token

    monkeypatch.setenv("MINDPAL_CHAT_PROVIDER", "openrouter")
    monkeypatch.setenv("MINDPAL_LLM_FALLBACK", "groq")
    monkeypatch.setattr(oai, "stream_text", fake_stream)

    assert _drain(LLMGateway().generate_stream(prompt="hi")) == ["ok"]
    assert len(seen) == 2


def test_midstream_failure_never_restarts_on_another_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: List[str] = []

    async def fake_stream(**kwargs: Any):
        attempts.append(kwargs["base_url"])
        yield "partial answer"
        raise OpenAICompatibleError("rate limited", 429)

    monkeypatch.setenv("MINDPAL_CHAT_PROVIDER", "openrouter")
    monkeypatch.setenv("MINDPAL_LLM_FALLBACK", "groq")
    monkeypatch.setattr(oai, "stream_text", fake_stream)

    async def run() -> None:
        async for _ in LLMGateway().generate_stream(prompt="hi"):
            pass

    with pytest.raises(LLMGatewayError):
        asyncio.run(run())
    assert len(attempts) == 1, (
        "the user already saw partial text; a second provider would repeat or "
        "contradict it mid-answer"
    )


def test_missing_provider_key_degrades_to_the_stub_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MINDPAL_CHAT_PROVIDER", "openrouter")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    tokens = _drain(LLMGateway().generate_stream(prompt="hi"))
    assert tokens and tokens[0].strip(), "an unconfigured provider must not hang the chat route"


# --- Reasoning must be off on the classifier path ------------------------------


def test_classifier_requests_disable_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same failure mode as Gemini's thinking budget, different provider.

    Many current models reason by default. An 80-token budget spent on a chain
    returns empty text, which the live session records as safety_unverified -
    paying for the chain and getting no verdict either way.
    """
    captured: Dict[str, Any] = {}

    class _Response:
        status_code = 200
        reason_phrase = "OK"

        @staticmethod
        def json() -> Dict[str, Any]:
            return {"choices": [{"message": {"content": '{"label":"not_crisis"}'}}]}

    class _Client:
        def post(self, path: str, json: Dict[str, Any]) -> Any:
            captured.update(json)
            return _Response()

    monkeypatch.setattr(oai, "_client", lambda *a, **k: _Client())
    oai.complete_json(prompt="User: hi", api_key="k", max_tokens=80)

    assert captured["reasoning"] == {"enabled": False}
    assert captured["response_format"] == {"type": "json_object"}
    assert captured["temperature"] == 0.0
    assert captured["max_tokens"] == 80


def test_each_provider_gets_its_own_model_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Groq ids are not OpenRouter ids. Sending one to the other 404s."""
    seen: Dict[str, Any] = {}
    monkeypatch.setattr(oai, "complete_json", lambda **kw: seen.update(kw) or '{"label":"x"}')
    monkeypatch.setenv("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
    monkeypatch.setenv("GROQ_MODEL", "qwen/qwen3.8-27b")

    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "openrouter")
    LLMGateway().generate_json(prompt="User: hi")
    assert seen["model"] == "google/gemma-4-31b-it:free"

    seen.clear()
    monkeypatch.setenv("MINDPAL_JSON_PROVIDER", "groq")
    LLMGateway().generate_json(prompt="User: hi")
    assert seen["model"] == "qwen/qwen3.8-27b", "groq must not be handed an OpenRouter id"


def test_groq_json_model_can_differ_from_groq_chat_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GROQ_MODEL", "openai/gpt-oss-120b")
    monkeypatch.setenv("GROQ_JSON_MODEL", "openai/gpt-oss-safeguard-20b")
    assert oai.groq_chat_model() == "openai/gpt-oss-120b"
    assert oai.groq_json_model() == "openai/gpt-oss-safeguard-20b"
    monkeypatch.delenv("GROQ_JSON_MODEL")
    assert oai.groq_json_model() == "openai/gpt-oss-120b", "falls back to the chat model"
