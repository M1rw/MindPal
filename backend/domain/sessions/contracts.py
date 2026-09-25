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
# Message fields the web client relies on after a reload or on another device
# (audit MP-12). Everything else is still dropped: this is a persisted contract,
# not a place to store arbitrary client data.
_MESSAGE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_INSIGHT_MOVE_RE = re.compile(r"^[a-z_]{1,24}$")
_ALLOWED_MESSAGE_KINDS = frozenset({"voice_receipt"})
_ALLOWED_MODELS = frozenset({"standard", "pro"})
_MAX_STRATEGY_CHARS = 64
_MAX_VOICE_SECONDS = 86_400


MAX_SESSIONS_PER_ACCOUNT = int(_LIMITS["max_sessions_per_account"])


def enforce_session_cap(store: Any, user_id_hash: str, session_id: str) -> None:
    """A new saved chat is refused once an account holds the cap (audit MP-17).

    Updates to an existing chat always go through; only creating the next one
    is refused, before anything is written. Counting stops at the cap.
    """
    if store.get_document("chat_sessions", f"{user_id_hash}:{session_id}") is not None:
        return
    count = 0
    for _doc_id, _doc in store.iter_documents("chat_sessions", prefix=f"{user_id_hash}:"):
        count += 1
        if count >= MAX_SESSIONS_PER_ACCOUNT:
            raise AppError(
                "quota_exceeded",
                f"Your account can keep up to {MAX_SESSIONS_PER_ACCOUNT} saved chats. Delete some to save new ones.",
            )


def validated_session_id(value: str) -> str:
    session_id = str(value or "").strip()
    if not _SESSION_ID_RE.match(session_id):
        raise AppError(
            "payload_invalid",
            "Chat session ids may only contain letters, digits, dots, colons, underscores and hyphens.",
        )
    return session_id


_ATTACHMENT_KINDS = frozenset({"image", "pdf"})
_ATTACHMENT_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_MAX_ATTACHMENTS = 4


def clipped_attachments(raw: Any) -> List[Dict[str, Any]]:
    """What a synced message keeps about its files: identity and shape, never links or bytes."""
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw[:_MAX_ATTACHMENTS]:
        if not isinstance(item, dict) or item.get("kind") not in _ATTACHMENT_KINDS:
            continue
        entry: Dict[str, Any] = {"kind": item["kind"], "name": str(item.get("name") or "")[:200]}
        for key in ("id", "fileId"):
            value = item.get(key)
            if isinstance(value, str) and _ATTACHMENT_ID_RE.match(value):
                entry[key] = value
        for key, limit in (("pages", 2000), ("size", 100_000_000)):
            value = item.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= limit:
                entry[key] = value
        mime = item.get("mime")
        if isinstance(mime, str) and len(mime) <= 80:
            entry["mime"] = mime
        out.append(entry)
    return out


def clipped_messages(raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    for item in raw[-MAX_MESSAGES_PER_SESSION:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in _ALLOWED_MESSAGE_ROLES:
            continue
        content = str(item.get("content") or item.get("text") or "")[:MAX_MESSAGE_CHARS]
        attachments = clipped_attachments(item.get("attachments"))
        if not content.strip() and not attachments:
            continue
        entry: Dict[str, Any] = {"role": role, "content": content}
        if attachments:
            entry["attachments"] = attachments
        message_id = item.get("id")
        # Stable ids are what edit, regenerate and dedupe key on; without them a
        # reloaded chat got new identities and the wrong message could be edited.
        if isinstance(message_id, str) and _MESSAGE_ID_RE.match(message_id):
            entry["id"] = message_id
        timestamp = item.get("timestamp") or item.get("createdAt") or item.get("created_at")
        if isinstance(timestamp, str) and timestamp.strip():
            entry["timestamp"] = timestamp.strip()[:MAX_TIMESTAMP_CHARS]
        kind = item.get("kind")
        if kind in _ALLOWED_MESSAGE_KINDS:
            entry["kind"] = kind
            seconds = item.get("voice_used_s")
            if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and 0 <= seconds <= _MAX_VOICE_SECONDS:
                entry["voice_used_s"] = int(seconds)
        strategy = item.get("strategy_used")
        if isinstance(strategy, str) and strategy.strip():
            entry["strategy_used"] = strategy.strip()[:_MAX_STRATEGY_CHARS]
        move = item.get("insight_move")
        if isinstance(move, str) and _INSIGHT_MOVE_RE.match(move):
            entry["insight_move"] = move
        model = item.get("model")
        if model in _ALLOWED_MODELS:
            entry["model"] = model
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
    # The person renamed it: automatic titling must not overwrite that elsewhere.
    titleLocked: bool = False
    # Pinned to the top of search on every device.
    pinned: bool = False
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
