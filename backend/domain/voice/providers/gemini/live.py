from __future__ import annotations

import time
from typing import Any

from backend.domain.voice.providers.live import LiveVoiceCapabilities, LiveVoiceCircuit, LiveVoiceHealth
from backend.domain.voice.services.token import ALLOWED_VOICE_IDS, VoiceTokenService


class GeminiLiveVoiceProvider:
    name = "gemini"

    def __init__(self, token_service: VoiceTokenService | None = None) -> None:
        self.token_service = token_service or VoiceTokenService()
        self.circuit = LiveVoiceCircuit()
        self._last_latency_ms = 0

    def capabilities(self) -> LiveVoiceCapabilities:
        return LiveVoiceCapabilities(
            native_audio=True,
            input_transcription=True,
            output_transcription=True,
            session_resumption=True,
            proactivity=True,
            compression=True,
            safety_settings=True,
            voices=tuple(sorted(ALLOWED_VOICE_IDS)),
        )

    def _configured(self) -> bool:
        # Health is informational; a token service without the probe counts as configured.
        probe = getattr(self.token_service, "is_configured", None)
        return bool(probe()) if callable(probe) else True

    def health(self) -> LiveVoiceHealth:
        circuit = "open" if self.circuit.opened_at > 0 and not self.circuit.allow(time.time()) else "closed"
        return LiveVoiceHealth(
            provider=self.name,
            status="healthy" if self._configured() and circuit != "open" else "unavailable",
            circuit=circuit,
            latency_ms=self._last_latency_ms,
            last_failure=self.circuit.last_failure,
            fallback_eligible=False,
        )

    def mint(self, **kwargs: Any) -> dict[str, Any]:
        now = time.perf_counter()
        if not self.circuit.allow(time.time()):
            raise RuntimeError("Gemini live provider circuit is open")
        try:
            result = self.token_service.mint_ephemeral_token(**kwargs)
            self._last_latency_ms = max(0, int((time.perf_counter() - now) * 1000))
            self.circuit.success()
            return result
        except Exception as exc:
            self._last_latency_ms = max(0, int((time.perf_counter() - now) * 1000))
            self.circuit.failure(str(exc), time.time())
            raise
