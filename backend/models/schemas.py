# backend/models/schemas.py

from __future__ import annotations


from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.security import Locale, normalize_locale, sanitize_text
from backend.models._helpers import sanitize_metadata, utcnow


MAX_ERROR_MESSAGE_CHARS = 500
MAX_ERROR_CODE_CHARS = 120
MAX_REQUEST_ID_CHARS = 80
MAX_PROVIDER_CHARS = 80
MAX_TTS_TEXT_CHARS = 4_000
MAX_AUDIO_BASE64_CHARS = 5_000_000
MAX_METADATA_ITEMS = 50
MAX_METADATA_VALUE_CHARS = 300


_utcnow = utcnow


class ApiStatus(str, Enum):
    OK = "ok"
    ERROR = "error"


class HealthState(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"
    ERROR = "error"


class ApiMeta(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=MAX_REQUEST_ID_CHARS)
    timestamp: datetime = Field(default_factory=_utcnow)
    version: str | None = Field(default=None, max_length=40)

    @field_validator("request_id", "version", mode="before")
    @classmethod
    def _clean_optional_short_text(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), MAX_REQUEST_ID_CHARS)
        if not cleaned:
            raise ValueError("field cannot be empty")

        return cleaned


class ApiErrorDetail(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    code: str = Field(min_length=1, max_length=MAX_ERROR_CODE_CHARS)
    message: str = Field(min_length=1, max_length=MAX_ERROR_MESSAGE_CHARS)
    status_code: int = Field(ge=100, le=599)
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("code", mode="before")
    @classmethod
    def _clean_code(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_ERROR_CODE_CHARS)
        if not cleaned:
            raise ValueError("error code cannot be empty")
        return cleaned

    @field_validator("message", mode="before")
    @classmethod
    def _clean_message(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_ERROR_MESSAGE_CHARS)
        if not cleaned:
            raise ValueError("error message cannot be empty")
        return cleaned

    @field_validator("details", mode="before")
    @classmethod
    def _clean_details(cls, value: object) -> dict[str, str | int | float | bool | None]:
        return sanitize_metadata(value)


class ApiErrorResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    status: ApiStatus = ApiStatus.ERROR
    error: ApiErrorDetail
    meta: ApiMeta | None = None

    @model_validator(mode="after")
    def _force_error_status(self) -> ApiErrorResponse:
        if self.status != ApiStatus.ERROR:
            raise ValueError("ApiErrorResponse status must be error")
        return self


class ApiMessageResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    status: ApiStatus = ApiStatus.OK
    message: str = Field(min_length=1, max_length=500)
    meta: ApiMeta | None = None

    @field_validator("message", mode="before")
    @classmethod
    def _clean_message(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 500)
        if not cleaned:
            raise ValueError("message cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def _force_ok_status(self) -> ApiMessageResponse:
        if self.status != ApiStatus.OK:
            raise ValueError("ApiMessageResponse status must be ok")
        return self


class DependencyHealth(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    state: HealthState = HealthState.OK
    enabled: bool = True
    latency_ms: float | None = Field(default=None, ge=0.0)
    detail: str | None = Field(default=None, max_length=300)

    @field_validator("name", "detail", mode="before")
    @classmethod
    def _clean_optional_text(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), 300)
        return cleaned or None


class HealthResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    status: HealthState = HealthState.OK
    project_name: str = Field(default="MindPal", min_length=1, max_length=80)
    version: str = Field(default="1.0.0", min_length=1, max_length=40)
    environment: str = Field(default="development", min_length=1, max_length=40)
    uptime_seconds: float | None = Field(default=None, ge=0.0)
    dependencies: list[DependencyHealth] = Field(default_factory=list, max_length=30)
    timestamp: datetime = Field(default_factory=_utcnow)

    @field_validator("project_name", "version", "environment", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 80)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


class TTSFormat(str, Enum):
    MP3 = "mp3"
    WAV = "wav"
    OGG = "ogg"


class TTSRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_TTS_TEXT_CHARS)
    locale: Locale = "auto"
    voice_id: str | None = Field(default=None, max_length=120)
    format: TTSFormat = TTSFormat.MP3
    speaking_rate: float = Field(default=1.0, ge=0.5, le=2.0)

    @field_validator("text", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_TTS_TEXT_CHARS)
        if not cleaned:
            raise ValueError("TTS text cannot be empty")
        return cleaned

    @field_validator("locale", mode="before")
    @classmethod
    def _normalize_locale(cls, value: object) -> Locale:
        return normalize_locale(str(value)) if value is not None else "auto"

    @field_validator("voice_id", mode="before")
    @classmethod
    def _clean_voice_id(cls, value: object) -> str | None:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), 120)
        return cleaned or None


class TTSResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=MAX_REQUEST_ID_CHARS)
    provider_used: str = Field(default="browser", min_length=1, max_length=MAX_PROVIDER_CHARS)
    fallback_to_browser: bool = True
    mime_type: str | None = Field(default=None, max_length=80)
    audio_url: str | None = Field(default=None, max_length=2_000)
    audio_base64: str | None = Field(default=None, max_length=MAX_AUDIO_BASE64_CHARS)
    latency_ms: float = Field(default=0.0, ge=0.0)

    @field_validator("request_id", "provider_used", "mime_type", "audio_url", mode="before")
    @classmethod
    def _clean_optional_text(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), 2_000)
        if not cleaned:
            raise ValueError("field cannot be empty")

        return cleaned

    @model_validator(mode="after")
    def _validate_audio_or_browser_fallback(self) -> TTSResponse:
        if not self.fallback_to_browser and not (self.audio_url or self.audio_base64):
            raise ValueError(
                "TTSResponse requires audio_url or audio_base64 unless fallback_to_browser=true"
            )
        return self


class SafetyPingResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    status: ApiStatus = ApiStatus.OK
    local_rules_loaded: bool = False
    perspective_enabled: bool = False
    output_guard_enabled: bool = False
    supported_locales: list[Locale] = Field(default_factory=lambda: ["en", "ar"], max_length=10)
    meta: ApiMeta | None = None

    @model_validator(mode="after")
    def _force_ok_status(self) -> SafetyPingResponse:
        if self.status != ApiStatus.OK:
            raise ValueError("SafetyPingResponse status must be ok")
        return self


class ProviderCallTrace(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    provider: str = Field(min_length=1, max_length=MAX_PROVIDER_CHARS)
    attempted: bool = False
    succeeded: bool = False
    skipped: bool = False
    latency_ms: float | None = Field(default=None, ge=0.0)
    error_code: str | None = Field(default=None, max_length=120)

    @field_validator("provider", "error_code", mode="before")
    @classmethod
    def _clean_optional_text(cls, value: object) -> object:
        if value is None:
            return None

        cleaned = sanitize_text(str(value), 120)
        if not cleaned:
            raise ValueError("field cannot be empty")

        return cleaned

    @model_validator(mode="after")
    def _validate_trace_state(self) -> ProviderCallTrace:
        true_states = sum([self.attempted, self.succeeded, self.skipped])

        if true_states == 0:
            raise ValueError("provider trace must be attempted, succeeded, or skipped")

        if self.succeeded and self.skipped:
            raise ValueError("provider trace cannot be both succeeded and skipped")

        if self.succeeded and not self.attempted:
            raise ValueError("succeeded provider trace must also be attempted")

        return self


class ProviderChainTrace(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=MAX_REQUEST_ID_CHARS)
    provider_used: str = Field(min_length=1, max_length=MAX_PROVIDER_CHARS)
    fallback_count: int = Field(default=0, ge=0, le=10)
    user_id_hash: str | None = Field(default=None, max_length=120)
    calls: list[ProviderCallTrace] = Field(default_factory=list, max_length=10)

    @field_validator("request_id", "provider_used", mode="before")
    @classmethod
    def _clean_short_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), MAX_PROVIDER_CHARS)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned

    @field_validator("user_id_hash", mode="before")
    @classmethod
    def _clean_optional_hash(cls, value: object) -> str | None:
        if value is None:
            return None
        cleaned = sanitize_text(str(value), 120)
        return cleaned or None


class ValidationIssue(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    field: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=300)

    @field_validator("field", "message", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 300)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


# _sanitize_metadata moved to _helpers.sanitize_metadata