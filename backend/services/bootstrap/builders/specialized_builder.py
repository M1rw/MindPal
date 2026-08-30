"""
Specialized service builders (Brain, Memory Repo, Feature Flags, etc.).

These are miscellaneous services that don't fit into other categories.
"""

from backend.core.config import Settings
from backend.services import DBService
from backend.services.brain_service import BrainService
from backend.services.feature_flags_service import FeatureFlagsService
from backend.services.memory_repository import MemoryRepository
from backend.services.voice_v4_token_service import VoiceV4TokenService
import httpx


def build_memory_repository(db: DBService) -> MemoryRepository:
    """
    Construct memory repository.

    Args:
        db: Database service

    Returns:
        MemoryRepository instance
    """
    return MemoryRepository(db=db)


def build_brain_service() -> BrainService:
    """
    Construct brain service.

    Returns:
        BrainService instance
    """
    return BrainService()


def build_feature_flags_service() -> FeatureFlagsService:
    """
    Construct feature flags service.

    Returns:
        FeatureFlagsService instance
    """
    return FeatureFlagsService()


def build_voice_v4_tokens_service(
    settings: Settings, http_client: httpx.AsyncClient
) -> VoiceV4TokenService:
    """
    Construct voice v4 token service.

    Args:
        settings: Application settings
        http_client: Shared HTTP client

    Returns:
        VoiceV4TokenService instance
    """
    return VoiceV4TokenService(settings=settings, client=http_client)
