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
from .db_service import (
    DBProvider,
    DBService,
    InMemoryDBProvider,
)
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

__all__ = [
    "AuthIdentity",
    "AuthProvider",
    "AuthResolutionMeta",
    "AuthService",
    "BrowserFallbackTTSProvider",
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
    "LLMServiceResult",
    "MemoryCompactionMeta",
    "MemoryExtraction",
    "MemoryService",
    "OfflineLLMProvider",
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
    "TTSPolicy",
    "TTSProvider",
    "TTSService",
    "TTSServiceMeta",
    "build_llm_request",
    "build_memory_interactions",
    "hash_matched_fragment",
    "parse_bearer_token",
]