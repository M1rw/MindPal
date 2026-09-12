# backend/features/chat/schemas.py

"""
Chat domain schemas, request/response contracts, and message models.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import Locale, normalize_locale, sanitize_text

MAX_CHAT_MESSAGE_CHARS = 4_000
MAX_ASSISTANT_REPLY_CHARS = 12_000
MAX_HISTORY_MESSAGES = 100
MAX_LLM_MESSAGES = 120
MAX_LLM_PROMPT_CHARS = 12_000
MAX_PROVIDER_NAME_CHARS = 80
MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS = 800


class ChatRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class LLMRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatChannel(str, Enum):
    WEB = "web"
    DISCORD = "discord"
    API = "api"
    TEST = "test"


class ChatMessage(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    role: ChatRole
    content: str = Field(min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS)

    @field_validator("content", mode="before")
    @classmethod
    def _sanitize_content(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_CHAT_MESSAGE_CHARS)
        if not cleaned:
            raise ValueError("message content cannot be empty")
        return cleaned


class LLMMessage(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    role: LLMRole
    content: str = Field(min_length=1, max_length=MAX_LLM_PROMPT_CHARS)

    @field_validator("content", mode="before")
    @classmethod
    def _sanitize_content(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_LLM_PROMPT_CHARS)
        if not cleaned:
            raise ValueError("LLM message content cannot be empty")
        return cleaned


class ChatMetadata(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    locale: Locale = "auto"
    channel: ChatChannel = ChatChannel.WEB
    voice: bool = False
    mode: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default="standard", max_length=80)
    client_request_id: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=80)
    communication_style: str | None = Field(default=None, max_length=40)
    directness: str | None = Field(default=None, max_length=20)
    cognitive_structure: bool | None = None
    fast_answers: bool | None = None
    custom_instructions: str | None = Field(default=None, max_length=MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS)

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"


class RagReference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    source: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=80)
    technique: str = Field(min_length=1, max_length=120)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)


class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_HISTORY_MESSAGES)
    metadata: ChatMetadata = Field(default_factory=ChatMetadata)

    @field_validator("messages", mode="before")
    @classmethod
    def _validate_messages(cls, value: object) -> list[Any]:
        if not isinstance(value, list) or not value:
            raise ValueError("at least one message is required")
        return value


class ChatResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    message: str = Field(min_length=1, max_length=MAX_ASSISTANT_REPLY_CHARS)
    request_id: str = Field(min_length=1, max_length=120)
    provider: str = Field(default="gemini", max_length=MAX_PROVIDER_NAME_CHARS)
    safety_level: str = Field(default="safe", max_length=80)
    from_cache: bool = False
    rag_references: list[RagReference] = Field(default_factory=list, max_length=10)
    session_id: str | None = Field(default=None, max_length=120)


class ChatStoreRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    session_id: str = Field(min_length=1, max_length=120)
    messages: list[ChatMessage] = Field(min_length=2, max_length=MAX_HISTORY_MESSAGES)


class ChatSession(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=120)
    user_id_hash: str = Field(min_length=1, max_length=160)
    created_at: str = ""
    updated_at: str = ""
    message_count: int = Field(default=0, ge=0)
    locale: Locale = "auto"
    channel: ChatChannel = ChatChannel.WEB
