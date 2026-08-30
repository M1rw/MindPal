# tests/integration/test_bootstrap_lifecycle.py

import pytest
from backend.core.config import Settings
from backend.services.bootstrap import build_service_container


@pytest.mark.asyncio
async def test_full_bootstrap_lifecycle():
    settings = Settings(
        ENVIRONMENT="test",
        OFFLINE_MODE=True,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=True,
    )
    container = build_service_container(settings)

    await container.start()
    health = await container.health()
    assert "status" in health

    await container.stop()
