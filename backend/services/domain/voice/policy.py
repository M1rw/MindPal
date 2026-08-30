# backend/services/domain/voice/policy.py

from __future__ import annotations

from dataclasses import dataclass
from backend.models.schemas import TTSFormat


@dataclass(frozen=True, slots=True)
class TTSPolicy:
    locale: str
    voice_id: str | None
    speaking_rate: float
    format: TTSFormat
    browser_fallback_allowed: bool
    external_tts_allowed: bool
    reason: str


@dataclass(frozen=True, slots=True)
class TTSServiceMeta:
    mode: str
    provider_used: str
    fallback_used: bool
    external_attempted: bool
    error_code: str | None = None
