# backend/services/tts_service.py

"""
TTS Service re-export module for backward compatibility.
Implementation moved to backend.services.domain.voice.
"""

from __future__ import annotations

from backend.services.domain.voice import (
    BrowserFallbackTTSProvider,
    TTSPolicy,
    TTSProvider,
    TTSService,
    TTSServiceMeta,
)

__all__ = [
    "BrowserFallbackTTSProvider",
    "TTSPolicy",
    "TTSProvider",
    "TTSService",
    "TTSServiceMeta",
]
