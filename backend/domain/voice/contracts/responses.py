from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class VoiceResponseModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class VoiceUsageResponse(VoiceResponseModel):
    used_s: int = Field(ge=0)
    cap_s: int = Field(ge=0)
    remaining_s: int = Field(ge=0)
    reserve_s: int = Field(ge=0)
    in_call: bool
    day: str


class VoiceSessionActionResponse(VoiceResponseModel):
    ok: bool
    action: str


class VoiceAnalyticsResponse(VoiceResponseModel):
    user_id_hash: str
    session_id: str
    event_count: int = Field(ge=0)
    events_by_name: dict[str, int]
    outcomes: dict[str, int]
    duration_ms_total: int = Field(ge=0)
    status: str


class VoiceAuditResponse(VoiceAnalyticsResponse):
    session: dict[str, Any]
    risk: dict[str, Any]
    timeline: list[dict[str, Any]]


class VoiceTokenResponse(VoiceResponseModel):
    token: str
    expires_at: str
    ws_url: str
    model: str
    voice_id: str
    session_id: str
    quota_remaining_s: int = Field(ge=0)
    setup_timeout_ms: int = Field(ge=0)
    hold_ms: int = Field(ge=0)
    session_limit_s: int = Field(ge=0)
    setup: dict[str, Any]


class VoiceReactionResponse(VoiceResponseModel):
    reaction: str


class VoiceRecallResponse(VoiceResponseModel):
    result: str
    found: bool


class VoiceSummaryResponse(VoiceResponseModel):
    skipped: bool
    reason: str | None = None
    summary: str | None = None
    message: dict[str, Any] | None = None
    memory: dict[str, Any] | None = None
