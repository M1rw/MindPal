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
    "ApiErrorDetail",
    "ApiErrorResponse",
    "ApiMessageResponse",
    "ApiMeta",
    "ApiStatus",
    "ChatChannel",
    "ChatMessage",
    "ChatMetadata",
    "ChatRequest",
    "ChatResponse",
    "ChatRole",
    "ChatSafetyView",
    "CommunicationStyle",
    "CrisisResponseTemplate",
    "DependencyHealth",
    "HealthResponse",
    "HealthState",
    "LLMMessage",
    "LLMRequest",
    "LLMResponse",
    "LLMRole",
    "CommunicationPreferences",
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
    "ProviderCallTrace",
    "ProviderChainTrace",
    "RagReference",
    "SafetyAction",
    "SafetyDecision",
    "SafetyEvent",
    "SafetyLevel",
    "SafetyMatchedRule",
    "SafetyPingResponse",
    "SafetySource",
    "TTSFormat",
    "TTSRequest",
    "TTSResponse",
    "UserChannel",
    "UserPreferences",
    "UserProfile",
    "UserProfileResponse",
    "UserProfileUpdate",
    "UserSafetyPreference",
    "UserSession",
    "UserStatus",
    "ValidationIssue",
]
