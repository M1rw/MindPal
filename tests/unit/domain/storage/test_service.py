# Storage domain tests

import pytest

from backend.services.domain.storage import StorageService
from backend.models.user import UserProfile


@pytest.mark.asyncio
async def test_storage_service_health():
    service = StorageService()
    health = await service.health()
    assert "provider" in health
    assert "configured" in health
    assert "mock_mode" in health


@pytest.mark.asyncio
async def test_storage_service_user_profile_round_trip():
    service = StorageService()
    profile = UserProfile(user_id_hash="user_123")
    saved = await service.save_user_profile(profile)
    loaded = await service.load_user_profile("user_123")

    assert saved.profile.user_id_hash == "user_123"
    assert loaded.loaded is True
    assert loaded.profile.user_id_hash == "user_123"


@pytest.mark.asyncio
async def test_storage_service_memory_round_trip():
    service = StorageService()

    from backend.models.memory import MemorySummary, MemorySource

    summary = MemorySummary(
        user_id_hash="user_456",
        source=MemorySource.CHAT_EXTRACTION,
        summary_text="User prefers calm pacing.",
        model_version="v1",
    )

    await service.save_memory(summary)
    loaded = await service.load_memory("user_456")

    assert loaded.loaded is True
    assert loaded.summary is not None
    assert "calm pacing" in loaded.summary.summary_text.lower()
