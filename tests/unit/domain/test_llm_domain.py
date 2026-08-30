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
