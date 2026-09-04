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
