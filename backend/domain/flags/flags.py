# backend/domain/flags/flags.py — Feature Flags Domain

from __future__ import annotations

from typing import Dict, Any

from backend.domain.flags.engine import FeatureLifecycleEngine


class FeatureFlagsService:
    """Evaluates dynamic feature flags and client operational capabilities."""

    def __init__(self, engine: FeatureLifecycleEngine | None = None) -> None:
        self.engine = engine or FeatureLifecycleEngine()

    def get_flags_snapshot(self, user_id_hash: str) -> Dict[str, Any]:
        return self.engine.get_snapshot(user_id_hash)

