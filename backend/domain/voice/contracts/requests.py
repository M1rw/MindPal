from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class VoiceTokenRequest(BaseModel):
    consent_attested: bool = False
    voice_id: Optional[str] = Field(default=None, max_length=64)
    voice_language: Optional[str] = Field(default=None, max_length=16)
    personalization: Optional[Dict[str, Any]] = None
    guest_id: Optional[str] = Field(default=None, max_length=128)


class VoiceReactionRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    context: str = Field(default="", max_length=2000)
    speaker: Literal["caller", "mindpal"] = "caller"


class VoiceRecallRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    tool: Literal["search_memory", "search_past_chats", "search_library"]
    query: str = Field(default="", max_length=2000)


class VoiceSessionEventRequest(BaseModel):
    session_id: Optional[str] = None
    event: str = Field(min_length=1, max_length=64)
    to: Optional[str] = Field(default=None, max_length=32)
    reason: Optional[str] = Field(default=None, max_length=160)
    text: Optional[str] = Field(default=None, max_length=12000)
    is_final: bool = False
    input_text: Optional[str] = Field(default=None, max_length=24000)
    output_text: Optional[str] = Field(default=None, max_length=24000)
    input_ledger: Optional[str] = Field(default=None, max_length=24000)
    output_ledger: Optional[str] = Field(default=None, max_length=24000)
    working_memory: Optional[Dict[str, Any]] = None
    force_classify: bool = False
    source: Optional[str] = Field(default=None, max_length=32)
    t_setup_ms: Optional[int] = Field(default=None, ge=0)
    used_s: Optional[int] = Field(default=None, ge=0)
    played_ms: Optional[int] = Field(default=None, ge=0)
    resumption_handle: Optional[str] = Field(default=None, max_length=4096)
    risk: Optional[float] = Field(default=None, ge=0, le=10)
    danger_kind: Optional[str] = Field(default=None, max_length=64)
    band: Optional[str] = Field(default=None, max_length=32)
    confirmations: Optional[int] = Field(default=None, ge=0)


class VoiceSummarizeRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    chat_session_id: Optional[str] = Field(default=None, max_length=128)
    user_transcript: str = Field(default="", max_length=24000)
    ai_transcript: str = Field(default="", max_length=24000)
    used_s: int = Field(default=0, ge=0)


class VoiceDiagnosticsRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    trace: Dict[str, Any]
