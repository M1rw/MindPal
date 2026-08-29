# backend/features/voice/service.py

"""
Text-to-Speech synthesis coordinator and fallback service.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import ProviderError, ValidationAppError
from backend.core.security import sanitize_text
from backend.models.schemas import TTSFormat, TTSRequest, TTSResponse

logger = logging.getLogger(__name__)

MAX_TTS_TEXT_CHARS = 4_000


class TTSProvider(Protocol):
    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        ...


class BrowserFallbackTTSProvider:
    name = "browser"

    @property
    def is_configured(self) -> bool:
        return True

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        return TTSResponse(
            request_id="tts_browser_fallback",
            provider_used=self.name,
            fallback_to_browser=True,
            mime_type=None,
            audio_url=None,
            audio_base64=None,
            latency_ms=0.0,
        )


class TTSService:
    """Orchestrates TTS generation across external providers and browser fallback."""

    def __init__(
        self,
        *,
        provider: TTSProvider | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.provider = provider
        self.browser_fallback = BrowserFallbackTTSProvider()

    async def synthesize(self, request: TTSRequest) -> TTSResponse:
        cleaned_text = sanitize_text(request.text, MAX_TTS_TEXT_CHARS).strip()
        if not cleaned_text:
            raise ValidationAppError("TTS input text cannot be empty", field="text")

        sanitized_request = TTSRequest(
            text=cleaned_text,
            voice_id=request.voice_id,
            locale=request.locale,
            speaking_rate=request.speaking_rate,
            format=request.format,
            response_mode=request.response_mode,
            safety_level=request.safety_level,
            allow_browser_fallback=request.allow_browser_fallback,
        )

        if self.provider is not None and self.provider.is_configured and not self._is_crisis(request.safety_level):
            try:
                return await self.provider.synthesize(sanitized_request)
            except Exception as exc:
                logger.warning("tts_provider_failed provider=%s error=%s", self.provider.name, type(exc).__name__)
                if not sanitized_request.allow_browser_fallback:
                    raise ProviderError(f"TTS synthesis failed: {exc}", code="tts_failed") from exc

        return await self.browser_fallback.synthesize(sanitized_request)

    def _is_crisis(self, safety_level: str | None) -> bool:
        return str(safety_level or "").lower() in ("self_harm_imminent", "abuse_or_violence")
