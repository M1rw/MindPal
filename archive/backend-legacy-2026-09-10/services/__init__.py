# backend/services/__init__.py

"""
MindPal backend services package.

Exposes canonical domain service boundaries and container bootstrap.
"""

from __future__ import annotations

from backend.services.cache_service import CacheService, cache_key
from backend.services.configs import (
    LLMServiceConfig,
    MemoryServiceConfig,
    OutputGuardServiceConfig,
    SafetyServiceConfig,
    TTSServiceConfig,
)
from backend.services.domain.admin import AdminAuthority, SupabaseAdminRepository
from backend.services.domain.auth import (
    AuthIdentity,
    AuthProvider,
    AuthResolutionMeta,
    AuthService,
    FirebaseAuthProvider,
    OfflineAuthProvider,
    parse_bearer_token,
)
from backend.services.domain.features import FeatureFlagsService, FeaturePolicyStore
from backend.services.domain.intelligence import (
    ClinicalExtractor,
    ResponseEvaluation,
    ResponseIntelligenceService,
    extract_clinical_profile,
    finalize_user_reply,
)
from backend.services.domain.llm import (
    LLMProvider,
    LLMService,
    LLMServiceResult,
    OfflineLLMProvider,
    build_llm_request,
)
from backend.services.domain.memory import (
    BrainService,
    LLMCompactionOutcome,
    MemoryCompactionMeta,
    MemoryExtraction,
    MemoryService,
    archive_memory_atom,
    build_memory_graph_prompt,
    build_memory_interactions,
    delete_memory_atom,
    extract_memory_graph_from_text,
    extract_memory_graph_from_text_llm,
    memory_graph_delta_from_summary,
    merge_memory_graph,
    render_context_pack_for_prompt,
    upsert_memory_atom,
)
from backend.services.domain.quota import (
    IdempotencyRecord,
    IdempotencyService,
    QuotaDecision,
    QuotaService,
    RateLimitDecision,
    RateLimitService,
)
from backend.services.domain.rag import (
    GroundingUnit,
    PreparedSearchTerm,
    RAGQueryPlan,
    RAGRetrievalResult,
    RAGService,
    RetrievalMatch,
)
from backend.services.domain.safety import (
    CompiledExclusionRule,
    CompiledSafetyRule,
    SafetyClassifier,
    SafetyClassifierMeta,
    SafetyRuleMatch,
    SafetyService,
    hash_matched_fragment,
    strip_code_fence,
)
from backend.services.domain.storage import (
    DBProvider,
    FirebaseDBProvider,
    InMemoryDBProvider,
    StorageDocument,
    StorageHealth,
    StorageProvider,
    StorageQuery,
    StorageService,
    StorageService as DBService,
    UnavailableDBProvider,
)
from backend.services.domain.voice import (
    BrowserFallbackTTSProvider,
    TTSPolicy,
    TTSProvider,
    TTSService,
    TTSServiceMeta,
    VoiceV4TokenService,
)
from backend.services.job_queue_service import AsyncJobQueueService, QueuedJob
from backend.services.memory_repository import MemoryRepository
from backend.services.output_guard_service import (
    CompiledOutputRule,
    OutputGuardMatch,
    OutputGuardResult,
    OutputGuardService,
)


class ServiceContainer:
    """Lazy proxy to the canonical bootstrap container implementation."""

    def __new__(cls, *args, **kwargs):
        from .bootstrap.container import ServiceContainer as _ServiceContainer

        return _ServiceContainer(*args, **kwargs)


def build_service_container(*args, **kwargs):
    from .bootstrap import build_service_container as _build_service_container

    return _build_service_container(*args, **kwargs)


__all__ = [
    "AdminAuthority",
    "AsyncJobQueueService",
    "AuthIdentity",
    "AuthProvider",
    "AuthResolutionMeta",
    "AuthService",
    "BrainService",
    "BrowserFallbackTTSProvider",
    "CacheService",
    "ClinicalExtractor",
    "CompiledExclusionRule",
    "CompiledOutputRule",
    "CompiledSafetyRule",
    "DBProvider",
    "DBService",
    "FeatureFlagsService",
    "FeaturePolicyStore",
    "FirebaseAuthProvider",
    "FirebaseDBProvider",
    "GroundingUnit",
    "IdempotencyRecord",
    "IdempotencyService",
    "InMemoryDBProvider",
    "LLMCompactionOutcome",
    "LLMProvider",
    "LLMService",
    "LLMServiceConfig",
    "LLMServiceResult",
    "MemoryCompactionMeta",
    "MemoryExtraction",
    "MemoryRepository",
    "MemoryService",
    "MemoryServiceConfig",
    "OfflineAuthProvider",
    "OfflineLLMProvider",
    "OutputGuardMatch",
    "OutputGuardResult",
    "OutputGuardService",
    "OutputGuardServiceConfig",
    "PreparedSearchTerm",
    "QueuedJob",
    "QuotaDecision",
    "QuotaService",
    "RAGQueryPlan",
    "RAGRetrievalResult",
    "RAGService",
    "RateLimitDecision",
    "RateLimitService",
    "ResponseEvaluation",
    "ResponseIntelligenceService",
    "RetrievalMatch",
    "SafetyClassifier",
    "SafetyClassifierMeta",
    "SafetyRuleMatch",
    "SafetyService",
    "SafetyServiceConfig",
    "ServiceContainer",
    "StorageDocument",
    "StorageHealth",
    "StorageProvider",
    "StorageQuery",
    "StorageService",
    "SupabaseAdminRepository",
    "TTSPolicy",
    "TTSProvider",
    "TTSService",
    "TTSServiceConfig",
    "TTSServiceMeta",
    "UnavailableDBProvider",
    "VoiceV4TokenService",
    "archive_memory_atom",
    "build_llm_request",
    "build_memory_graph_prompt",
    "build_memory_interactions",
    "build_service_container",
    "cache_key",
    "delete_memory_atom",
    "extract_clinical_profile",
    "extract_memory_graph_from_text",
    "extract_memory_graph_from_text_llm",
    "finalize_user_reply",
    "hash_matched_fragment",
    "memory_graph_delta_from_summary",
    "merge_memory_graph",
    "parse_bearer_token",
    "render_context_pack_for_prompt",
    "strip_code_fence",
    "upsert_memory_atom",
]
