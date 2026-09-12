# backend/models/__init__.py

"""
MindPal Pydantic model package.

This package defines typed, sanitized data contracts for API payloads,
safety decisions, chat orchestration, memory compaction, user profiles,
provider traces, health responses, and TTS responses.

Importing this package must not:
- connect to external services
- load provider clients
- read or write databases
- configure global logging
- perform safety classification
"""

from __future__ import annotations

from .chat import (
    ChatChannel,
    ChatMessage,
    ChatMetadata,
    ChatRequest,
    ChatResponse,
    ChatRole,
    ChatSafetyView,
    LLMMessage,
    LLMRequest,
    LLMResponse,
    LLMRole,
    RagReference,
)
from .memory import (
    # Enums
    LegacyMemoryCategory,
    MemoryCategory,
    MemoryInteractionRole,
    MemorySensitivity,
    MemorySource,
    MemoryStatus,
    MemoryTier,
    # Graph types (primary)
    MemoryAtom,
    MemoryGraph,
    MemoryGraphLoadResult,
    MemoryGraphPatch,
    MemoryGraphWriteResult,
    # Legacy types (backward compat)
    CommunicationPreferences,
    ImportantPerson,
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryInteraction,
    MemoryItem,
    MemoryLoadResult,
    MemorySummary,
    MemoryWriteResult,
    RelationshipFact,
    # Functions
    build_memory_prompt_from_graph,
    canonical_memory_key,
    grouped_active_atoms,
    make_memory_atom,
    memory_graph_from_summary,
    normalize_memory_value,
    summary_from_memory_graph,
)
from .safety import (
    CrisisResponseTemplate,
    SafetyAction,
    SafetyDecision,
    SafetyEvent,
    SafetyLevel,
    SafetyMatchedRule,
    SafetySource,
)
from .schemas import (
    ApiErrorDetail,
    ApiErrorResponse,
    ApiMessageResponse,
    ApiMeta,
    ApiStatus,
    DependencyHealth,
    HealthResponse,
    HealthState,
    ProviderCallTrace,
    ProviderChainTrace,
    SafetyPingResponse,
    TTSFormat,
    TTSRequest,
    TTSResponse,
    ValidationIssue,
)
from .user import (
    CommunicationStyle,
    UserChannel,
    UserPreferences,
    UserProfile,
    UserProfileResponse,
    UserProfileUpdate,
    UserSafetyPreference,
    UserSession,
    UserStatus,
)

__all__ = [
    # API
    "ApiErrorDetail",
    "ApiErrorResponse",
    "ApiMessageResponse",
    "ApiMeta",
    "ApiStatus",
    # Chat
    "ChatChannel",
    "ChatMessage",
    "ChatMetadata",
    "ChatRequest",
    "ChatResponse",
    "ChatRole",
    "ChatSafetyView",
    # Communication
    "CommunicationPreferences",
    "CommunicationStyle",
    # Crisis
    "CrisisResponseTemplate",
    # Health
    "DependencyHealth",
    "HealthResponse",
    "HealthState",
    # LLM
    "LLMMessage",
    "LLMRequest",
    "LLMResponse",
    "LLMRole",
    # Memory (unified)
    "ImportantPerson",
    "LegacyMemoryCategory",
    "MemoryAtom",
    "MemoryCategory",
    "MemoryCompactionRequest",
    "MemoryCompactionResult",
    "MemoryGraph",
    "MemoryGraphLoadResult",
    "MemoryGraphPatch",
    "MemoryGraphWriteResult",
    "MemoryInteraction",
    "MemoryInteractionRole",
    "MemoryItem",
    "MemoryLoadResult",
    "MemorySensitivity",
    "MemorySource",
    "MemoryStatus",
    "MemorySummary",
    "MemoryTier",
    "MemoryWriteResult",
    "RelationshipFact",
    # Memory functions
    "build_memory_prompt_from_graph",
    "canonical_memory_key",
    "grouped_active_atoms",
    "make_memory_atom",
    "memory_graph_from_summary",
    "normalize_memory_value",
    "summary_from_memory_graph",
    # Provider
    "ProviderCallTrace",
    "ProviderChainTrace",
    # RAG
    "RagReference",
    # Safety
    "SafetyAction",
    "SafetyDecision",
    "SafetyEvent",
    "SafetyLevel",
    "SafetyMatchedRule",
    "SafetyPingResponse",
    "SafetySource",
    # TTS
    "TTSFormat",
    "TTSRequest",
    "TTSResponse",
    # User
    "UserChannel",
    "UserPreferences",
    "UserProfile",
    "UserProfileResponse",
    "UserProfileUpdate",
    "UserSafetyPreference",
    "UserSession",
    "UserStatus",
    # Validation
    "ValidationIssue",
]
