from __future__ import annotations

from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

from backend.configs.runtime import api_limits_config
from backend.domain.files.contracts import MAX_FILES_IN_CONTEXT, AttachmentRef

_LIMITS = api_limits_config()["chat"]
MAX_MESSAGE_CHARS = int(_LIMITS["max_message_chars"])
MAX_HISTORY_TURNS = int(_LIMITS["max_history_turns"])
MAX_HISTORY_TURN_CHARS = int(_LIMITS["max_history_turn_chars"])
MAX_TELEMETRY_KEYS = int(_LIMITS["max_telemetry_keys"])
MAX_PERSONALIZATION_KEYS = int(_LIMITS["max_personalization_keys"])
MAX_NESTED_VALUE_CHARS = int(_LIMITS["max_nested_value_chars"])
_ALLOWED_MODELS = frozenset({"standard", "pro"})


def _bounded_flat_map(value: Optional[Dict[str, Any]], *, limit: int, label: str) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if len(value) > limit:
        raise ValueError(f"{label} supports at most {limit} keys")
    cleaned: Dict[str, Any] = {}
    for key, item in value.items():
        name = str(key).strip()[:64]
        if not name:
            continue
        if item is None or isinstance(item, (bool, int, float)):
            cleaned[name] = item
        elif isinstance(item, str):
            cleaned[name] = item[:MAX_NESTED_VALUE_CHARS]
    return cleaned


class ChatHistoryTurn(BaseModel):
    role: str = Field(max_length=32)
    content: str = Field(default="", max_length=MAX_HISTORY_TURN_CHARS)
    text: Optional[str] = Field(default=None, max_length=MAX_HISTORY_TURN_CHARS)

    def body(self) -> str:
        return (self.content or self.text or "").strip()


class ClientLocation(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: Optional[float] = Field(default=None, ge=0, le=100_000)


class ClientContext(BaseModel):
    timezone: Optional[str] = Field(default=None, max_length=64)
    locale: Optional[str] = Field(default=None, max_length=32)
    location: Optional[ClientLocation] = None

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            return None
        return value


class ChatStreamPayload(BaseModel):
    message: str = Field(default="", max_length=MAX_MESSAGE_CHARS)
    history: List[ChatHistoryTurn] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)
    session_id: Optional[str] = Field(default=None, max_length=128)
    model: Optional[str] = "standard"
    telemetry: Optional[Dict[str, Any]] = None
    personalization: Optional[Dict[str, Any]] = None
    client_context: Optional[ClientContext] = None
    attachments: List[AttachmentRef] = Field(default_factory=list, max_length=MAX_FILES_IN_CONTEXT)
    # The interactive card kind ("" for none) of each recent assistant reply,
    # newest first, so MindPal keeps cards occasional (backend/domain/chat/cards.py).
    recent_cards: List[str] = Field(default_factory=list, max_length=8)

    @field_validator("message")
    @classmethod
    def strip_message(cls, value: str) -> str:
        return (value or "").strip()

    @model_validator(mode="after")
    def message_or_files(self) -> "ChatStreamPayload":
        # A file on its own is a message too ("here, look at this").
        if not self.message and not any(not a.earlier for a in self.attachments):
            raise ValueError("message must not be empty")
        return self

    @field_validator("recent_cards")
    @classmethod
    def known_cards(cls, value: List[str]) -> List[str]:
        from backend.domain.chat.cards import KINDS

        return [kind if kind in KINDS else "" for kind in value]

    @field_validator("model")
    @classmethod
    def known_model(cls, value: Optional[str]) -> str:
        tier = str(value or "standard").strip().lower()
        if tier not in _ALLOWED_MODELS:
            raise ValueError(f"model must be one of {sorted(_ALLOWED_MODELS)}")
        return tier

    @field_validator("telemetry")
    @classmethod
    def bounded_telemetry(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return _bounded_flat_map(value, limit=MAX_TELEMETRY_KEYS, label="telemetry")

    @field_validator("personalization")
    @classmethod
    def bounded_personalization(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return _bounded_flat_map(value, limit=MAX_PERSONALIZATION_KEYS, label="personalization")
