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
    CommunicationPreferences,
    ImportantPerson,
    MemoryCategory,
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryInteraction,
    MemoryInteractionRole,
    MemoryItem,
    MemoryLoadResult,
    MemorySensitivity,
    MemorySource,
    MemorySummary,
    MemoryWriteResult,
    RelationshipFact,
)
from .memory_v3 import (
    MemoryAtom,
    MemoryCategory as MemoryGraphCategory,
    MemoryGraph,
    MemoryGraphLoadResult,
    MemoryGraphPatch,
    MemoryGraphWriteResult,
    MemorySensitivity as MemoryGraphSensitivity,
    MemorySource as MemoryGraphSource,
    MemoryStatus,
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
    # Memory (v1/v2 — flat summary format)
    "ImportantPerson",
    "MemoryCategory",
    "MemoryCompactionRequest",
    "MemoryCompactionResult",
    "MemoryInteraction",
    "MemoryInteractionRole",
    "MemoryItem",
    "MemoryLoadResult",
    "MemorySensitivity",
    "MemorySource",
    "MemorySummary",
    "MemoryWriteResult",
    "RelationshipFact",
    # Memory (v3 — graph/atom format)
    "MemoryAtom",
    "MemoryGraph",
    "MemoryGraphCategory",
    "MemoryGraphLoadResult",
    "MemoryGraphPatch",
    "MemoryGraphSensitivity",
    "MemoryGraphSource",
    "MemoryGraphWriteResult",
    "MemoryStatus",
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
