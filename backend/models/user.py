# backend/models/user.py

from __future__ import annotations

from typing import Any
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import (
    Locale,
    hash_user_id,
    normalize_locale,
    redact_basic_pii,
    safe_truncate,
    sanitize_text,
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


def _utcnow() -> datetime:
    return datetime.now(UTC)


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
        cleaned = _clean_profile_text(str(value), 80)
        return cleaned or None


class UserPreferences(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    locale: Locale = "auto"
    timezone: str | None = Field(default=None, max_length=MAX_TIMEZONE_CHARS)
    communication_style: CommunicationStyle = CommunicationStyle.BALANCED
    preferred_name: str | None = Field(default=None, max_length=MAX_DISPLAY_NAME_CHARS)
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
        cleaned = _clean_profile_text(str(value), MAX_TIMEZONE_CHARS)
        return cleaned or None

    @field_validator("preferred_name", mode="before")
    @classmethod
    def _clean_preferred_name(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = _clean_profile_text(str(value), MAX_DISPLAY_NAME_CHARS)
        return cleaned or None

    @field_validator("preferred_coping_tools", "wellness_goals", "avoided_topics", mode="before")
    @classmethod
    def _clean_list_fields(cls, value: object) -> list[str]:
        return _clean_profile_list(value)

    @field_validator("custom_instructions", mode="before")
    @classmethod
    def _clean_custom_instructions(cls, value: object) -> str:
        return _clean_profile_text(str(value or ""), MAX_CUSTOM_INSTRUCTIONS_CHARS)

    @field_validator("ui_settings", mode="before")
    @classmethod
    def _clean_ui_settings(cls, value: object) -> dict[str, Any]:
        return _clean_ui_settings(value)


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
        return _clean_profile_list(value)

    @field_validator("treatment_plan", mode="before")
    @classmethod
    def _clean_treatment_plan(cls, value: object) -> str:
        return _clean_profile_text(str(value or ""), MAX_PROFILE_TEXT_CHARS)


class UsageProfile(BaseModel):
    """
    Usage metrics for the 5-hour rolling limit window.
    """
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    pro_messages_count: int = Field(default=0, ge=0)
    pro_last_reset_time: float = Field(default=0.0, ge=0.0)


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
        return _clean_profile_text(str(value or ""), MAX_PROFILE_TEXT_CHARS)

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_metadata(cls, value: object) -> dict[str, str | int | float | bool | None]:
        return _clean_metadata(value)

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
        cleaned = _clean_profile_text(str(value), MAX_PROFILE_TEXT_CHARS)
        return cleaned or None

    @field_validator("metadata", mode="before")
    @classmethod
    def _clean_optional_metadata(
        cls,
        value: object,
    ) -> dict[str, str | int | float | bool | None] | None:
        if value is None:
            return None
        return _clean_metadata(value)


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
        return _clean_metadata(value)

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


def _clean_profile_text(text: str, max_chars: int) -> str:
    cleaned = sanitize_text(text, max_chars)
    cleaned = redact_basic_pii(cleaned)
    return safe_truncate(cleaned, max_chars)


def _clean_profile_list(value: object) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        raw_items: Sequence[object] = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    else:
        raw_items = [value]

    seen: set[str] = set()
    cleaned_items: list[str] = []

    for item in raw_items:
        cleaned = _clean_profile_text(str(item or ""), MAX_PROFILE_LIST_ITEM_CHARS)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        cleaned_items.append(cleaned)

        if len(cleaned_items) >= MAX_PROFILE_LIST_ITEMS:
            break

    return cleaned_items


def _clean_metadata(value: object) -> dict[str, str | int | float | bool | None]:
    if value is None:
        return {}

    if not isinstance(value, Mapping):
        raise TypeError("metadata must be a mapping")

    cleaned: dict[str, str | int | float | bool | None] = {}

    for raw_key, raw_value in list(value.items())[:MAX_METADATA_ITEMS]:
        key = sanitize_text(str(raw_key or ""), 80)
        if not key:
            continue

        if raw_value is None or isinstance(raw_value, (bool, int, float)):
            cleaned[key] = raw_value
        else:
            cleaned[key] = _clean_profile_text(str(raw_value), MAX_METADATA_VALUE_CHARS)

    return cleaned


def _clean_ui_settings(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}

    cleaned: dict[str, Any] = {}

    for raw_key, raw_value in value.items():
        if len(cleaned) >= MAX_UI_SETTINGS_ITEMS:
            break

        key = _clean_profile_text(str(raw_key or ""), MAX_METADATA_VALUE_CHARS)
        if not key:
            continue

        cleaned[key] = _clean_ui_setting_value(raw_value, depth=0)

    return cleaned


def _clean_ui_setting_value(value: object, *, depth: int) -> Any:
    if depth >= 4:
        return _clean_profile_text(str(value or ""), MAX_UI_SETTINGS_VALUE_CHARS)

    if value is None or isinstance(value, bool):
        return value

    if isinstance(value, int | float):
        return value

    if isinstance(value, str):
        return _clean_profile_text(value, MAX_UI_SETTINGS_VALUE_CHARS)

    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:MAX_UI_SETTINGS_ITEMS]:
            key = _clean_profile_text(str(raw_key or ""), MAX_METADATA_VALUE_CHARS)
            if key:
                output[key] = _clean_ui_setting_value(raw_value, depth=depth + 1)
        return output

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [
            _clean_ui_setting_value(item, depth=depth + 1)
            for item in list(value)[:MAX_PROFILE_LIST_ITEMS]
        ]

    return _clean_profile_text(str(value or ""), MAX_UI_SETTINGS_VALUE_CHARS)
