# backend/models/user.py

from __future__ import annotations

from typing import Any
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import (
    Locale,
    hash_user_id,
    normalize_locale,
    sanitize_text,
)
from backend.models._helpers import (
    sanitize_metadata,
    sanitize_pii_text,
    sanitize_string_list,
    sanitize_ui_settings,
    utcnow,
)


MAX_USER_ID_CHARS = 160
MAX_DISPLAY_NAME_CHARS = 80
MAX_TIMEZONE_CHARS = 80
MAX_PROFILE_TEXT_CHARS = 500
MAX_PROFILE_LIST_ITEMS = 50
MAX_PROFILE_LIST_ITEM_CHARS = 180
MAX_METADATA_ITEMS = 30
MAX_METADATA_VALUE_CHARS = 300
MAX_CUSTOM_INSTRUCTIONS_CHARS = 800
MAX_UI_SETTINGS_ITEMS = 80
MAX_UI_SETTINGS_VALUE_CHARS = 800


_utcnow = utcnow
_clean_profile_text = sanitize_pii_text


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
    """
    User-facing safety preferences.

    These preferences do not weaken deterministic crisis handling. Crisis bypass
    and safety policy always override user preferences.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    allow_memory: bool = True
    allow_safety_event_logging: bool = True
    allow_product_improvement: bool = False
    prefer_short_crisis_responses: bool = True
    emergency_country_hint: str | None = Field(default=None, max_length=80)

    @field_validator("emergency_country_hint", mode="before")
    @classmethod
    def _clean_country_hint(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_pii_text(str(value), 80)
        return cleaned or None


class UserPreferences(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    locale: Locale = "auto"
    timezone: str | None = Field(default=None, max_length=MAX_TIMEZONE_CHARS)
    communication_style: CommunicationStyle = CommunicationStyle.BALANCED
    preferred_name: str | None = Field(default=None, max_length=MAX_DISPLAY_NAME_CHARS)
    gender: str | None = Field(default=None, max_length=20)  # "male", "female", or None
    preferred_coping_tools: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    wellness_goals: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    avoided_topics: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    custom_instructions: str = Field(default="", max_length=MAX_CUSTOM_INSTRUCTIONS_CHARS)
    ui_settings: dict[str, Any] = Field(default_factory=dict)
    safety: UserSafetyPreference = Field(default_factory=UserSafetyPreference)

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @field_validator("timezone", mode="before")
    @classmethod
    def _clean_timezone(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_pii_text(str(value), MAX_TIMEZONE_CHARS)
        return cleaned or None

    @field_validator("preferred_name", mode="before")
    @classmethod
    def _clean_preferred_name(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_pii_text(str(value), MAX_DISPLAY_NAME_CHARS)
        return cleaned or None

    @field_validator("gender", mode="before")
    @classmethod
    def _clean_gender(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 20).lower().strip()
        if cleaned in ("male", "female"):
            return cleaned
        return None

    @field_validator("preferred_coping_tools", "wellness_goals", "avoided_topics", mode="before")
    @classmethod
    def _clean_list_fields(cls, value: object) -> list[str]:
        return sanitize_string_list(value, max_items=MAX_PROFILE_LIST_ITEMS, max_item_chars=MAX_PROFILE_LIST_ITEM_CHARS)

    @field_validator("custom_instructions", mode="before")
    @classmethod
    def _clean_custom_instructions(cls, value: object) -> str:
        return sanitize_pii_text(str(value or ""), MAX_CUSTOM_INSTRUCTIONS_CHARS)

    @field_validator("ui_settings", mode="before")
    @classmethod
    def _clean_ui_settings(cls, value: object) -> dict[str, Any]:
        return sanitize_ui_settings(value)


class ClinicalScore(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    date: str = Field(min_length=1, max_length=80)
    score: int = Field(ge=0, le=30)

class ClinicalProfile(BaseModel):
    """
    Structured clinical data for MindPal Pro.
    """
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    presenting_problems: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    suspected_diagnoses: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_LIST_ITEMS)
    treatment_plan: str = Field(default="", max_length=MAX_PROFILE_TEXT_CHARS)
    phq9_history: list[ClinicalScore] = Field(default_factory=list, max_length=50)
    gad7_history: list[ClinicalScore] = Field(default_factory=list, max_length=50)

    @field_validator("presenting_problems", "suspected_diagnoses", mode="before")
    @classmethod
    def _clean_list_fields(cls, value: object) -> list[str]:
        return sanitize_string_list(value, max_items=MAX_PROFILE_LIST_ITEMS, max_item_chars=MAX_PROFILE_LIST_ITEM_CHARS)

    @field_validator("treatment_plan", mode="before")
    @classmethod
    def _clean_treatment_plan(cls, value: object) -> str:
        return sanitize_pii_text(str(value or ""), MAX_PROFILE_TEXT_CHARS)


class UsageProfile(BaseModel):
    """
    Usage metrics with dual rolling-window credit tracking.

    Credit costs:  standard message = 1 credit, pro message = 2 credits.
    Windows:       5-hour (50 credits), 1-week (500 credits).
    The more restrictive window applies.
    """
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    # Legacy pro-only fields (kept for backward compatibility)
    pro_messages_count: int = Field(default=0, ge=0)
    pro_last_reset_time: float = Field(default=0.0, ge=0.0)

    # Unified credit system
    total_credits_5h: int = Field(default=0, ge=0)
    credits_5h_reset_time: float = Field(default=0.0, ge=0.0)
    total_credits_week: int = Field(default=0, ge=0)
    credits_week_reset_time: float = Field(default=0.0, ge=0.0)
    total_messages_count: int = Field(default=0, ge=0)


class UserProfile(BaseModel):
    """
    Sanitized user profile stored by the backend.

    raw_user_id may be accepted at construction time, but only user_id_hash is
    stored in the model. Do not persist raw identifiers from this model layer.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    user_id_hash: str = Field(min_length=1, max_length=80)
    status: UserStatus = UserStatus.ACTIVE
    channel: UserChannel = UserChannel.WEB
    preferences: UserPreferences = Field(default_factory=UserPreferences)
    clinical: ClinicalProfile = Field(default_factory=ClinicalProfile)
    usage: UsageProfile = Field(default_factory=UsageProfile)
    notes: str = Field(default="", max_length=MAX_PROFILE_TEXT_CHARS)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned

    @field_validator("notes", mode="before")
    @classmethod
    def _clean_notes(cls, value: object) -> str:
        return sanitize_pii_text(str(value or ""), MAX_PROFILE_TEXT_CHARS)

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_metadata(cls, value: object) -> dict[str, str | int | float | bool | None]:
        return sanitize_metadata(value)

    @model_validator(mode="after")
    def _validate_timestamps(self) -> UserProfile:
        if self.updated_at < self.created_at:
            raise ValueError("updated_at cannot be before created_at")
        return self

    @classmethod
    def from_raw_user_id(
        cls,
        raw_user_id: str,
        *,
        channel: UserChannel | str = UserChannel.WEB,
        preferences: UserPreferences | None = None,
    ) -> UserProfile:
        clean_raw_id = sanitize_text(raw_user_id, MAX_USER_ID_CHARS) or "anonymous"
        return cls(
            user_id_hash=hash_user_id(clean_raw_id),
            channel=channel,
            preferences=preferences or UserPreferences(),
        )


class UserProfileUpdate(BaseModel):
    """
    Partial update payload for user profile preferences.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    preferences: UserPreferences | None = None
    clinical: ClinicalProfile | None = None
    notes: str | None = Field(default=None, max_length=MAX_PROFILE_TEXT_CHARS)
    metadata: dict[str, str | int | float | bool | None] | None = None

    @field_validator("notes", mode="before")
    @classmethod
    def _clean_optional_notes(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_pii_text(str(value), MAX_PROFILE_TEXT_CHARS)
        return cleaned or None

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_optional_metadata(
        cls,
        value: object,
    ) -> dict[str, str | int | float | bool | None] | None:
        if value is None:
            return None
        return sanitize_metadata(value)


class UserProfileResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    profile: UserProfile
    loaded: bool = True
    provider: str = Field(default="mock", min_length=1, max_length=80)

    @field_validator("provider", mode="before")
    @classmethod
    def _clean_provider(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or "mock"), 80)
        return cleaned or "mock"


class UserSession(BaseModel):
    """
    Minimal session identity passed through request handling.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    raw_user_id: str = Field(default="anonymous", min_length=1, max_length=MAX_USER_ID_CHARS)
    user_id_hash: str = Field(min_length=1, max_length=80)
    channel: UserChannel = UserChannel.WEB
    locale: Locale = "auto"
    authenticated: bool = False
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("raw_user_id", mode="before")
    @classmethod
    def _clean_raw_user_id(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or "anonymous"), MAX_USER_ID_CHARS)
        return cleaned or "anonymous"

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_user_hash(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("user_id_hash cannot be empty")
        return cleaned

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_metadata(cls, value: object) -> dict[str, str | int | float | bool | None]:
        return sanitize_metadata(value)

    @classmethod
    def anonymous(
        cls,
        raw_user_id: str = "anonymous",
        *,
        channel: UserChannel | str = UserChannel.WEB,
        locale: str = "auto",
    ) -> UserSession:
        clean_raw_id = sanitize_text(raw_user_id, MAX_USER_ID_CHARS) or "anonymous"
        return cls(
            raw_user_id=clean_raw_id,
            user_id_hash=hash_user_id(clean_raw_id),
            channel=channel,
            locale=locale,
            authenticated=False,
        )


# Helpers moved to _helpers.py: sanitize_pii_text, sanitize_string_list,
# sanitize_metadata, sanitize_ui_settings
