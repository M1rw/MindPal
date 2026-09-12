# backend/features/users/schemas.py

"""
User domain schemas, profile contracts, session models, and auth types.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import Locale, hash_user_id, normalize_locale, sanitize_text

MAX_USER_ID_CHARS = 160
MAX_DISPLAY_NAME_CHARS = 80
MAX_TIMEZONE_CHARS = 80
MAX_PROFILE_TEXT_CHARS = 500
MAX_PROFILE_LIST_ITEMS = 50
MAX_CUSTOM_INSTRUCTIONS_CHARS = 800


class UserStatus(str, Enum):
    ACTIVE = "active"
    DISABLED = "disabled"
    DELETED = "deleted"


class UserChannel(str, Enum):
    WEB = "web"
    DISCORD = "discord"
    API = "api"
    UNKNOWN = "unknown"


class CommunicationStyle(str, Enum):
    CONCISE = "concise"
    BALANCED = "balanced"
    DETAILED = "detailed"


class UserSafetyPreference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    allow_memory: bool = True
    allow_safety_event_logging: bool = True
    allow_product_improvement: bool = False
    prefer_short_crisis_responses: bool = True
    emergency_country_hint: str | None = Field(default=None, max_length=80)


class UserPreferences(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    locale: Locale = "auto"
    timezone: str | None = Field(default=None, max_length=MAX_TIMEZONE_CHARS)
    communication_style: CommunicationStyle = CommunicationStyle.BALANCED
    preferred_name: str | None = Field(default=None, max_length=MAX_DISPLAY_NAME_CHARS)
    gender: str | None = Field(default=None, max_length=20)
    preferred_coping_tools: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    wellness_goals: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    avoided_topics: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    custom_instructions: str = Field(default="", max_length=MAX_CUSTOM_INSTRUCTIONS_CHARS)
    ui_settings: dict[str, Any] = Field(default_factory=dict)
    safety: UserSafetyPreference = Field(default_factory=UserSafetyPreference)

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value) if value is not None else None)


class UserProfile(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=MAX_USER_ID_CHARS)
    display_name: str = Field(default="", max_length=MAX_DISPLAY_NAME_CHARS)
    status: UserStatus = UserStatus.ACTIVE
    preferences: UserPreferences = Field(default_factory=UserPreferences)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class UserProfileUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    display_name: str | None = Field(default=None, max_length=MAX_DISPLAY_NAME_CHARS)
    preferences: UserPreferences | None = None


class UserSession(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=MAX_USER_ID_CHARS)
    channel: UserChannel = UserChannel.WEB
    locale: Locale = "auto"
    authenticated: bool = False
    is_admin: bool = False
    auth_provider: str = "anonymous"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True, slots=True)
class AuthIdentity:
    raw_user_id: str
    provider: str
    email_verified: bool = False
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass(frozen=True, slots=True)
class AuthResolutionMeta:
    mode: str
    authenticated: bool
    provider: str
    fallback_used: bool
    error_code: str | None = None
