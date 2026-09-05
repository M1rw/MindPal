# tests/unit/domain/test_llm_domain.py

import pytest

from backend.models.chat import LLMMessage, LLMRole
from backend.services.domain.llm import (
    LLMService,
    OfflineLLMProvider,
    build_llm_request,
)


@pytest.mark.asyncio
async def test_offline_llm_provider():
    provider = OfflineLLMProvider()
    assert provider.is_configured
    assert provider.name == "offline"

    request = build_llm_request(
        request_id="req_1",
        system_prompt="You are helpful.",
        user_message="I feel anxious today",
    )

    response = await provider.generate(request)
    assert response.provider_used == "offline"
    assert len(response.text) > 0


@pytest.mark.asyncio
async def test_llm_service_fallback_orchestration():
    service = LLMService(
        providers=[OfflineLLMProvider()],
        include_offline_provider=True,
        require_remote_provider=False,
        allow_offline_in_production=True,
    )

    request = build_llm_request(
        request_id="req_2",
        system_prompt="You are helpful.",
        user_message="Hello MindPal",
    )

    result = await service.generate_with_trace(request)
    assert result.response.provider_used == "offline"
    assert result.trace.request_id == "req_2"


def test_requires_verified_web_search():
    from backend.services.domain.llm.freshness import requires_verified_web_search

    # Blank / empty inputs
    assert not requires_verified_web_search("")
    assert not requires_verified_web_search("   ")

    # Non-volatile messages
    assert not requires_verified_web_search("hello how are you?")
    assert not requires_verified_web_search("I am feeling a bit stressed and overwhelmed")

    # Volatile English officeholders / facts / prices / weather
    assert requires_verified_web_search("who is the current mayor of New York?")
    assert requires_verified_web_search("what is the price of bitcoin right now?")
    assert requires_verified_web_search("what is today's weather in Cairo?")
    assert requires_verified_web_search("who is the prime minister?")

    # Volatile Arabic queries
    assert requires_verified_web_search("من هو رئيس الوزراء الحالي؟")
    assert requires_verified_web_search("كم سعر الذهب اليوم؟")
    assert requires_verified_web_search("ما هو الطقس الآن؟")

    # Long input truncation (verified within first 500 characters)
    long_msg = "what is the current price of gold? " + "hello " * 200
    assert requires_verified_web_search(long_msg)


import json
from pathlib import Path

from backend.models.chat import ChatMessage, ChatRequest
from backend.services.domain.llm.chat_orchestrator import convert_history


def test_convert_history_and_request_builder_contract_cases(caplog):
    # Case (a): History <= 30 with current message included -> current user message appears rendering exactly once
    current_msg = "I feel very overwhelmed today"
    history_included = [
        ChatMessage(role=LLMRole.USER, content="Hello"),
        ChatMessage(role=LLMRole.ASSISTANT, content="Hi, how can I support you?"),
        ChatMessage(role=LLMRole.USER, content=current_msg),
    ]
    payload_a = ChatRequest(message=current_msg, history=history_included)
    history_a = convert_history(payload_a)
    assert len(history_a) == 2
    assert history_a[-1].role == LLMRole.ASSISTANT

    request_a = build_llm_request(
        request_id="req_a",
        system_prompt="System prompt",
        user_message=current_msg,
        history=history_a,
    )
    user_turns_a = [m for m in request_a.messages if m.role == LLMRole.USER and m.content == current_msg]
    assert len(user_turns_a) == 1
    assert request_a.messages[-1].content == current_msg

    # Case (b): History > 30 with current message included -> current user message appears rendering exactly once
    long_history_with_current = []
    for i in range(20):
        long_history_with_current.append(ChatMessage(role=LLMRole.USER, content=f"User turn {i}"))
        long_history_with_current.append(ChatMessage(role=LLMRole.ASSISTANT, content=f"Bot turn {i}"))
    long_history_with_current.append(ChatMessage(role=LLMRole.USER, content=current_msg))

    payload_b = ChatRequest(message=current_msg, history=long_history_with_current)
    history_b = convert_history(payload_b)
    assert len(history_b) <= 30
    assert history_b[-1].role == LLMRole.ASSISTANT

    request_b = build_llm_request(
        request_id="req_b",
        system_prompt="System prompt",
        user_message=current_msg,
        history=history_b,
    )
    user_turns_b = [m for m in request_b.messages if m.role == LLMRole.USER and m.content == current_msg]
    assert len(user_turns_b) == 1
    assert request_b.messages[-1].content == current_msg

    # Case (c): History > 30 without current message -> history preserved correctly and current message appended once
    long_history_without_current = []
    for i in range(20):
        long_history_without_current.append(ChatMessage(role=LLMRole.USER, content=f"User turn {i}"))
        long_history_without_current.append(ChatMessage(role=LLMRole.ASSISTANT, content=f"Bot turn {i}"))

    payload_c = ChatRequest(message=current_msg, history=long_history_without_current)
    history_c = convert_history(payload_c)
    assert len(history_c) == 30
    assert history_c[-1].role == LLMRole.ASSISTANT

    request_c = build_llm_request(
        request_id="req_c",
        system_prompt="System prompt",
        user_message=current_msg,
        history=history_c,
    )
    assert request_c.messages[-1].content == current_msg
    assert request_c.messages[-2].role == LLMRole.ASSISTANT

    # Case (d): Request builder defensive guard drops duplicate and logs history_contract_violation
    raw_history_with_duplicate = [
        LLMMessage(role=LLMRole.USER, content="Hello"),
        LLMMessage(role=LLMRole.ASSISTANT, content="Hi there"),
        LLMMessage(role=LLMRole.USER, content=current_msg),
    ]
    request_d = build_llm_request(
        request_id="req_d",
        system_prompt="System prompt",
        user_message=current_msg,
        history=raw_history_with_duplicate,
    )
    assert len(request_d.messages) == 4  # System, User(Hello), Assistant(Hi there), User(current_msg)
    assert "history_contract_violation" in caplog.text


def test_audit_persona_fixtures_prompt_assembly():
    fixtures_dir = Path("data/audit_fixtures")
    fixture_files = list(fixtures_dir.glob("*.json"))
    persona_files = [f for f in fixture_files if not f.name.endswith("results.json")]
    assert len(persona_files) >= 6, f"Expected at least 6 persona fixtures, found {len(persona_files)}"

    for fixture_path in persona_files:
        with open(fixture_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        chat_history_raw = data.get("chat_history", [])
        if not chat_history_raw:
            continue

        # Extract current turn vs history
        last_item = chat_history_raw[-1]
        user_msg = last_item.get("content") or last_item.get("text") or "Hello MindPal"

        # Build payload with full history including current message to test duplicate stripping
        history_objs = [
            ChatMessage(
                role=LLMRole.USER if (item.get("role") in ("user", "User")) else LLMRole.ASSISTANT,
                content=item.get("content") or item.get("text") or "",
            )
            for item in chat_history_raw
        ]

        payload = ChatRequest(message=user_msg, history=history_objs)
        converted = convert_history(payload)

        request = build_llm_request(
            request_id=f"test_{fixture_path.stem}",
            system_prompt="System instruction",
            user_message=user_msg,
            history=converted,
        )

        non_system_messages = request.messages[1:]
        assert len(non_system_messages) > 0

        # Grammar assertion: History alternates user/assistant, ending in assistant before current user message
        for i in range(len(non_system_messages) - 1):
            curr_role = non_system_messages[i].role
            next_role = non_system_messages[i + 1].role
            assert curr_role != next_role, f"Consecutive same-speaker messages found in {fixture_path.name} at index {i}: {curr_role}"

        # Current user message appears exactly once as the final message
        assert non_system_messages[-1].role == LLMRole.USER
        assert non_system_messages[-1].content == user_msg
