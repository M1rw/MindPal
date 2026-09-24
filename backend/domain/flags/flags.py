# backend/domain/flags/flags.py — Feature Flags Domain

from __future__ import annotations

from typing import Dict, Any

from backend.domain.flags.engine import FeatureLifecycleEngine


class FeatureFlagsService:
    """Evaluates dynamic feature flags and client operational capabilities."""

    def __init__(self, engine: FeatureLifecycleEngine | None = None) -> None:
        self.engine = engine or FeatureLifecycleEngine()

    def get_flags_snapshot(self, user_id_hash: str) -> Dict[str, Any]:
        snapshot = self.engine.get_snapshot(user_id_hash)
        # Not a rollout flag: whether a speech-to-text provider is configured.
        # Without one, the composer falls back to the browser's recogniser.
        from backend.infra.llm.transcribe import transcription_available

        available = transcription_available()
        snapshot["flags"]["dictation_server"] = available
        snapshot["dictation_server"] = available
        return snapshot

