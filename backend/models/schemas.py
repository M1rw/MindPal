from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class HealthState(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"
    ERROR = "error"


class DependencyHealth(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    name: str = "service"
    state: HealthState = HealthState.OK
    enabled: bool = True
    latency_ms: float | None = None
    detail: str | None = None


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    status: HealthState = HealthState.OK
    project_name: str = "MindPal"
    version: str = "5.0.5"
    environment: str = "development"
    uptime_seconds: float | None = None
    dependencies: list[DependencyHealth] = Field(default_factory=list)
    timestamp: datetime | None = None


class TTSResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    request_id: str = Field(min_length=1)
    provider_used: str = "browser"
    fallback_to_browser: bool = True
    mime_type: str | None = None
    audio_url: str | None = None
    audio_base64: str | None = None
    latency_ms: float = 0.0

    @model_validator(mode="after")
    def _validate_audio(self):
        if not self.fallback_to_browser and not (self.audio_url or self.audio_base64):
            raise ValueError("TTSResponse requires audio_url or audio_base64 unless fallback_to_browser=true")
        return self


class ProviderCallTrace(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    provider: str = "offline"
    attempted: bool = True
    succeeded: bool = False
    skipped: bool = False
    latency_ms: float | None = None
    error_code: str | None = None


class ProviderChainTrace(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    request_id: str = Field(min_length=1)
    provider_used: str = "offline"
    fallback_count: int = 0
    user_id_hash: str | None = None
    calls: list[ProviderCallTrace] = Field(default_factory=list)
    clinical_logic_version: str = "v4.0"
    prompt_hash: str | None = None
    safety_gate_version: str = "v1.2"
