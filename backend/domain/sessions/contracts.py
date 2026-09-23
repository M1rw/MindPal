from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator
from backend.configs.runtime import api_limits_config
from backend.core.errors import AppError

_LIMITS = api_limits_config()["sessions"]
MAX_SESSION_ID_CHARS = int(_LIMITS["max_session_id_chars"])
MAX_TITLE_CHARS = int(_LIMITS["max_title_chars"])
MAX_MESSAGES_PER_SESSION = int(_LIMITS["max_messages_per_session"])
MAX_MESSAGE_CHARS = int(_LIMITS["max_message_chars"])
MAX_TIMESTAMP_CHARS = int(_LIMITS["max_timestamp_chars"])
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_ALLOWED_MESSAGE_ROLES = frozenset({"user", "assistant", "model", "system"})


def validated_session_id(value: str) -> str:
    session_id = str(value or "").strip()
    if not _SESSION_ID_RE.match(session_id):
        raise AppError(
            "payload_invalid",
            "Chat session ids may only contain letters, digits, dots, colons, underscores and hyphens.",
        )
    return session_id


def clipped_messages(raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    for item in raw[-MAX_MESSAGES_PER_SESSION:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in _ALLOWED_MESSAGE_ROLES:
            continue
        content = str(item.get("content") or item.get("text") or "")[:MAX_MESSAGE_CHARS]
        if not content.strip():
            continue
        entry: Dict[str, Any] = {"role": role, "content": content}
        timestamp = item.get("timestamp") or item.get("createdAt") or item.get("created_at")
        if isinstance(timestamp, str) and timestamp.strip():
            entry["timestamp"] = timestamp.strip()[:MAX_TIMESTAMP_CHARS]
        messages.append(entry)
    return messages


class AppendMessagePayload(BaseModel):
    role: str
    content: str = Field(max_length=MAX_MESSAGE_CHARS)

    @field_validator("role")
    @classmethod
    def known_role(cls, value: str) -> str:
        role = str(value or "").strip().lower()
        if role not in _ALLOWED_MESSAGE_ROLES:
            raise ValueError(f"role must be one of {sorted(_ALLOWED_MESSAGE_ROLES)}")
        return role


class ChatSessionPayload(BaseModel):
    id: str = Field(max_length=MAX_SESSION_ID_CHARS)
    title: str = Field(default="", max_length=MAX_TITLE_CHARS)
    createdAt: str = Field(max_length=MAX_TIMESTAMP_CHARS)
    updatedAt: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_CHARS)
    messages: List[Dict[str, Any]] = Field(default_factory=list)

    @field_validator("messages")
    @classmethod
    def bounded_messages(cls, value: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return clipped_messages(value or [])


class CurrentSessionPayload(BaseModel):
    title: str = Field(default="", max_length=MAX_TITLE_CHARS)
    messages: List[Dict[str, Any]] = Field(default_factory=list)

    @field_validator("messages")
    @classmethod
    def bounded_messages(cls, value: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return clipped_messages(value or [])


class SessionTelemetryPayload(BaseModel):
    session_id: str = Field(max_length=MAX_SESSION_ID_CHARS)
    event: str = Field(default="heartbeat", max_length=64)
    active_duration_seconds: float = Field(default=0.0, ge=0, le=86_400)
    inactivity_count: int = Field(default=0, ge=0, le=100_000)
    total_idle_seconds: float = Field(default=0.0, ge=0, le=86_400)
    last_idle_duration_seconds: float = Field(default=0.0, ge=0, le=86_400)
    is_online: bool = True
