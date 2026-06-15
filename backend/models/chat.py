# backend/models/chat.py

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import Locale, normalize_locale, sanitize_text
from backend.models.safety import SafetyLevel

if TYPE_CHECKING:
    from backend.models.memory import MemorySummary


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
    client_request_id: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=80)
    ui_language: str | None = Field(default=None, max_length=20)
    communication_style: str | None = Field(default=None, max_length=40)
    directness: str | None = Field(default=None, max_length=20)
    egyptian_arabic_style: str | None = Field(default=None, max_length=20)
    cognitive_structure: bool | None = None
    fast_answers: bool | None = None
    custom_instructions: str | None = Field(default=None, max_length=MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS)

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @field_validator(
        "mode",
        "client_request_id",
        "timezone",
        "ui_language",
        "communication_style",
        "directness",
        "egyptian_arabic_style",
        mode="before",
    )
    @classmethod
    def _sanitize_optional_short_text(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 120)
        return cleaned or None

    @field_validator("custom_instructions", mode="before")
    @classmethod
    def _sanitize_custom_instructions(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS)
        return cleaned or None


class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id: str = Field(default="anonymous", min_length=1, max_length=160)
    message: str = Field(min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS)
    history: list[ChatMessage] = Field(default_factory=list, max_length=MAX_HISTORY_MESSAGES)
    metadata: ChatMetadata = Field(default_factory=ChatMetadata)
    stream: bool = False

    @field_validator("user_id", mode="before")
    @classmethod
    def _sanitize_user_id(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or "anonymous"), 160)
        return cleaned or "anonymous"

    @field_validator("message", mode="before")
    @classmethod
    def _sanitize_message(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_CHAT_MESSAGE_CHARS)
        if not cleaned:
            raise ValueError("message cannot be empty")
        return cleaned


class ChatSafetyView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    level: SafetyLevel
    bypass_llm: bool = False
    matched_rules: list[str] = Field(default_factory=list, max_length=50)
    user_visible_category: str = Field(default="general_support", min_length=1, max_length=80)

    @field_validator("matched_rules")
    @classmethod
    def _clean_matched_rules(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        cleaned: list[str] = []

        for item in value:
            rule_id = sanitize_text(str(item), 120)
            if not rule_id or rule_id in seen:
                continue
            seen.add(rule_id)
            cleaned.append(rule_id)

        return cleaned[:50]


class RagReference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    grounding_id: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=80)
    technique: str | None = Field(default=None, max_length=120)
    score: float = Field(default=0.0, ge=0.0, le=1.0)

    @field_validator("grounding_id", "category", "technique", mode="before")
    @classmethod
    def _sanitize_short_text(cls, value: object) -> object:
        if value is None:
            return None
        return sanitize_text(str(value), 120)


class ChatResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    reply: str = Field(min_length=1, max_length=MAX_ASSISTANT_REPLY_CHARS)
    safety: ChatSafetyView
    provider_used: str = Field(min_length=1, max_length=MAX_PROVIDER_NAME_CHARS)
    fallback_count: int = Field(default=0, ge=0, le=10)
    rag_used: list[RagReference] = Field(default_factory=list, max_length=20)
    memory_updated: bool = False
    memory_summary: dict | None = Field(default=None, description="Compacted memory summary returned from backend")
    memory_graph_delta: dict | None = Field(default=None, description="Memory V3 graph delta returned from backend")
    memory_graph_snapshot: dict | None = Field(default=None, description="Memory V3 full snapshot returned from backend")
    memory_graph_full_snapshot: bool = False
    request_id: str = Field(min_length=1, max_length=80)

    @field_validator("reply", mode="before")
    @classmethod
    def _sanitize_reply(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_ASSISTANT_REPLY_CHARS)
        if not cleaned:
            raise ValueError("reply cannot be empty")
        return cleaned

    @field_validator("provider_used", "request_id", mode="before")
    @classmethod
    def _sanitize_short_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_NAME_CHARS)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


class LLMRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=80)
    messages: list[LLMMessage] = Field(min_length=1, max_length=MAX_LLM_MESSAGES)
    temperature: float = Field(default=0.4, ge=0.0, le=1.5)
    max_output_tokens: int = Field(default=700, ge=64, le=4096)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("request_id", mode="before")
    @classmethod
    def _sanitize_request_id(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("request_id cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def _require_system_message(self) -> LLMRequest:
        if not any(message.role == LLMRole.SYSTEM for message in self.messages):
            raise ValueError("LLMRequest requires a system message")
        return self


class LLMResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_ASSISTANT_REPLY_CHARS)
    provider_used: str = Field(min_length=1, max_length=MAX_PROVIDER_NAME_CHARS)
    fallback_count: int = Field(default=0, ge=0, le=10)
    latency_ms: float = Field(default=0.0, ge=0.0)
    model_name: str | None = Field(default=None, max_length=120)
    finish_reason: str | None = Field(default=None, max_length=80)

    @field_validator("text", mode="before")
    @classmethod
    def _sanitize_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_ASSISTANT_REPLY_CHARS)
        if not cleaned:
            raise ValueError("LLM response text cannot be empty")
        return cleaned

    @field_validator("provider_used", "model_name", "finish_reason", mode="before")
    @classmethod
    def _sanitize_optional_short_text(cls, value: object) -> object:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 120)
        return cleaned or None
