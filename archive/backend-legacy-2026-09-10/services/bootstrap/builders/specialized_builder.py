"""
Specialized service builders (Brain, Memory Repo, Feature Flags, Message Understanding, Taxonomy, User Snapshot, etc.).

These are miscellaneous services that don't fit into other categories.
"""

from backend.core.config import Settings
from backend.services.domain.features import FeatureFlagsService
from backend.services.domain.intelligence.message_understanding import MessageUnderstandingService
from backend.services.domain.intelligence.taxonomy_service import TaxonomyService
from backend.services.domain.intelligence.user_snapshot_service import UserSnapshotService
from backend.services.domain.llm import LLMService
from backend.services.domain.memory import BrainService
from backend.services.domain.storage import StorageService as DBService
from backend.services.domain.voice import VoiceV4TokenService
from backend.services.memory_repository import MemoryRepository
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


def build_message_understanding_service(
    settings: Settings,
    llm: LLMService,
    taxonomy: TaxonomyService | None = None,
    user_snapshot: UserSnapshotService | None = None,
) -> MessageUnderstandingService:
    return MessageUnderstandingService(
        settings=settings,
        llm_service=llm,
        taxonomy_service=taxonomy,
        user_snapshot_service=user_snapshot,
    )


def build_taxonomy_service(
    settings: Settings, llm: LLMService
) -> TaxonomyService:
    return TaxonomyService(settings=settings, llm_service=llm)


def build_user_snapshot_service(
    settings: Settings, llm: LLMService
) -> UserSnapshotService:
    return UserSnapshotService(settings=settings, llm_service=llm)
