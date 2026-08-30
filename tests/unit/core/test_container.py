# tests/unit/core/test_container.py

import pytest
from backend.core.config import Settings
from backend.services.bootstrap import build_service_container


@pytest.mark.asyncio
async def test_container_registration_and_health():
    settings = Settings(
        ENVIRONMENT="test",
        OFFLINE_MODE=True,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=True,
    )
    container = build_service_container(settings)
    await container.start()
    
    assert container.auth is not None
    assert container.db is not None
    assert container.llm is not None
    assert container.memory is not None
    assert container.safety is not None
    assert container.tts is not None
    
    health_sync = container.sync_health()
    assert "status" in health_sync
    assert "services" in health_sync
    
    health_async = await container.health()
    assert "status" in health_async
    
    await container.stop()
