# backend/services/__init__.py

"""
MindPal backend services package.

This package exposes provider-agnostic service boundaries used by API routes,
background tasks, and bot adapters.

Importing this package must not:
- connect to Firebase
- call LLM providers
- call TTS providers
- run safety classification
- read/write databases
- configure global logging
"""

from __future__ import annotations

from .auth_service import (
    AuthIdentity,
    AuthProvider,
    AuthResolutionMeta,
    AuthService,
    parse_bearer_token,
)
from .cache_service import CacheService, cache_key
from .configs import (
    LLMServiceConfig,
    MemoryServiceConfig,
    OutputGuardServiceConfig,
    SafetyServiceConfig,
    TTSServiceConfig,
)
from .db_service import (
    DBProvider,
    DBService,
    InMemoryDBProvider,
)
from .job_queue_service import AsyncJobQueueService, QueuedJob
from .llm_service import (
    LLMProvider,
    LLMService,
    LLMServiceResult,
    OfflineLLMProvider,
    build_llm_request,
)
from .memory_service import (
    LLMCompactionOutcome,
    MemoryCompactionMeta,
    MemoryExtraction,
    MemoryService,
    build_memory_interactions,
)
from .output_guard_service import (
    CompiledOutputRule,
    OutputGuardMatch,
    OutputGuardResult,
    OutputGuardService,
)
from .rag_service import (
    GroundingUnit,
    RAGQueryPlan,
    RAGRetrievalResult,
    RAGService,
    RetrievalMatch,
)
from .safety_service import (
    CompiledExclusionRule,
    CompiledSafetyRule,
    SafetyClassifierMeta,
    SafetyRuleMatch,
    SafetyService,
    hash_matched_fragment,
)
from .tts_service import (
    BrowserFallbackTTSProvider,
    TTSPolicy,
    TTSProvider,
    TTSService,
    TTSServiceMeta,
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
    "AuthIdentity",
    "AuthProvider",
    "AuthResolutionMeta",
    "AuthService",
    "BrowserFallbackTTSProvider",
    "CacheService",
    "CompiledExclusionRule",
    "CompiledOutputRule",
    "CompiledSafetyRule",
    "DBProvider",
    "DBService",
    "GroundingUnit",
    "InMemoryDBProvider",
    "LLMCompactionOutcome",
    "LLMProvider",
    "LLMService",
    "AsyncJobQueueService",
    "LLMServiceConfig",
    "LLMServiceResult",
    "MemoryCompactionMeta",
    "MemoryExtraction",
    "MemoryService",
    "MemoryServiceConfig",
    "OfflineLLMProvider",
    "OutputGuardServiceConfig",
    "OutputGuardMatch",
    "OutputGuardResult",
    "OutputGuardService",
    "RAGQueryPlan",
    "RAGRetrievalResult",
    "RAGService",
    "RetrievalMatch",
    "SafetyClassifierMeta",
    "SafetyRuleMatch",
    "SafetyService",
    "SafetyServiceConfig",
    "TTSPolicy",
    "TTSProvider",
    "TTSService",
    "TTSServiceConfig",
    "TTSServiceMeta",
    "QueuedJob",
    "ServiceContainer",
    "build_llm_request",
    "build_memory_interactions",
    "build_service_container",
    "cache_key",
    "hash_matched_fragment",
    "parse_bearer_token",
]