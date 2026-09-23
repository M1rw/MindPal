from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ChatRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class LLMRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    locale: str | None = None
    channel: str | None = None
    voice: bool = False
    mode: str | None = None
    model: str | None = None
    client_request_id: str | None = None
    timezone: str | None = None
    ui_language: str | None = None
    communication_style: str | None = None
    directness: str | None = None
    egyptian_arabic_style: str | None = None
    cognitive_structure: bool | None = None
    fast_answers: bool | None = None
    custom_instructions: str | None = None


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    role: ChatRole = ChatRole.USER
    content: str = Field(min_length=1)


class LLMMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    role: LLMRole = LLMRole.USER
    content: str = Field(min_length=1)


class RagReference(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    grounding_id: str = Field(min_length=1)
    category: str = Field(min_length=1)
    technique: str | None = None
    score: float = Field(default=0.0, ge=0.0, le=1.0)


class ChatSafetyView(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    level: str = "general_support"
    bypass_llm: bool = False
    matched_rules: list[str] = Field(default_factory=list)
    user_visible_category: str = "general_support"


class ChatResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    reply: str = Field(min_length=1)
    safety: ChatSafetyView = Field(default_factory=ChatSafetyView)
    provider_used: str = "offline"
    fallback_count: int = Field(default=0, ge=0)
    rag_used: list[RagReference] = Field(default_factory=list)
    memory_updated: bool = False
    memory_summary: dict | None = None
    memory_graph_delta: dict | None = None
    memory_graph_snapshot: dict | None = None
    memory_graph_full_snapshot: bool = False
    usage: dict[str, int] | None = None
    request_id: str = Field(min_length=1)

    @field_validator("safety", mode="before")
    @classmethod
    def _safety_validator(cls, value):
        if value is None:
            return ChatSafetyView()
        if isinstance(value, ChatSafetyView):
            return value
        return ChatSafetyView.model_validate(value)

    @model_validator(mode="before")
    @classmethod
    def _normalize_flat_response(cls, data):
        if not isinstance(data, dict):
            return data
        if "reply" not in data and "message" in data:
            data = {**data, "reply": data["message"]}
        if "provider_used" not in data and "model" in data:
            data = {**data, "provider_used": data["model"]}
        if "request_id" not in data and "id" in data:
            data = {**data, "request_id": data["id"]}
        return data
