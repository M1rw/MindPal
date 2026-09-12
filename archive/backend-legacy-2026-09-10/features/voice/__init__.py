# backend/features/voice/__init__.py

"""
Voice and TTS feature public exports gatekeeper.
"""

from .routes import router
from .schemas import (
    VOICE_V4_CONTRACT,
    VOICE_V4_FEATURE_KEY,
    TTSRequest,
    TTSResponse,
    VoiceV4BaselineContract,
    VoiceV4Contract,
    VoiceV4Environment,
    VoiceV4PcmContract,
    VoiceV4ReleaseDecision,
    VoiceV4ReleaseReason,
)
from .service import BrowserFallbackTTSProvider, TTSProvider, TTSService
from .token_service import VoiceV4TokenGrant, VoiceV4TokenService

__all__ = [
    "BrowserFallbackTTSProvider",
    "TTSProvider",
    "TTSRequest",
    "TTSResponse",
    "TTSService",
    "VOICE_V4_CONTRACT",
    "VOICE_V4_FEATURE_KEY",
    "VoiceV4BaselineContract",
    "VoiceV4Contract",
    "VoiceV4Environment",
    "VoiceV4PcmContract",
    "VoiceV4ReleaseDecision",
    "VoiceV4ReleaseReason",
    "VoiceV4TokenGrant",
    "VoiceV4TokenService",
    "router",
]
