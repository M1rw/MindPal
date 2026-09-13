# backend/domain/flags/engine.py — Enterprise Feature Lifecycle & Consistent Bucketing Engine

from __future__ import annotations

import hashlib
from typing import Dict, Any, List, Optional

from backend.domain.flags.models import (
    FeatureDefinition,
    FeatureStage,
    EvaluationReason,
    FlagEvaluation,
)


class FeatureLifecycleEngine:
    """
    Tier-1 Consistent Hash Feature Flag & Lifecycle Engine.
    Provides deterministic percentage-based rollouts and deprecation tracking.
    """

    def __init__(self, registry: Optional[List[FeatureDefinition]] = None) -> None:
        self._registry: Dict[str, FeatureDefinition] = {}
        defaults = registry or self._default_capabilities()
        for feature in defaults:
            self.register(feature)

    @classmethod
    def _default_capabilities(cls) -> List[FeatureDefinition]:
        """Canonical MindPal domain capabilities adhering to domain taxonomy."""
        return [
            FeatureDefinition(
                key="voice.realtime",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="voice-team",
                description="Real-time spoken AI audio dialogue and streaming sessions",
            ),
            FeatureDefinition(
                key="memory.graph_sync",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="memory-team",
                description="Long-term semantic memory graph persistence and recall",
            ),
            FeatureDefinition(
                key="chat.reasoning_stream",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="chat-team",
                description="Live SSE stream for reasoning thought and conversational output",
            ),
            FeatureDefinition(
                key="intelligence.pro_models",
                stage=FeatureStage.BETA,
                rollout_percentage=100,
                owner="model-team",
                description="Access to advanced high-context reasoning models",
            ),
            FeatureDefinition(
                key="clinical.guidance",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="safety-team",
                description="Automated empathetic safety heuristics and escalation guidance",
            ),
            FeatureDefinition(
                key="analytics.insights",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="analytics-team",
                description="Privacy-preserving user reflection patterns and mood progression",
            ),
            FeatureDefinition(
                key="release.changelog",
                stage=FeatureStage.GA,
                rollout_percentage=100,
                owner="core-platform",
                description="Interactive feature update notifications and release drawer",
            ),
        ]

    def register(self, definition: FeatureDefinition) -> None:
        self._registry[definition.key] = definition

    def get_definition(self, key: str) -> Optional[FeatureDefinition]:
        return self._registry.get(key)

    def all_definitions(self) -> List[FeatureDefinition]:
        return list(self._registry.values())

    @staticmethod
    def compute_bucket(user_id_hash: str, feature_key: str) -> int:
        """
        Deterministic SHA-256 consistent hash bucketing (0-99).
        Guarantees that a given user consistently falls in the exact same percentile
        bucket across server restarts, edge workers, and browser sessions.
        """
        normalized = f"{user_id_hash.strip().lower()}:{feature_key.strip().lower()}"
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        # Take first 8 hex characters (32 bits) and modulo 100
        return int(digest[:8], 16) % 100

    def evaluate(self, key: str, user_id_hash: str) -> FlagEvaluation:
        feature = self._registry.get(key)
        if not feature:
            return FlagEvaluation(
                key=key,
                enabled=False,
                stage=FeatureStage.DARK_LAUNCH,
                reason=EvaluationReason.DEFAULT_OFF,
            )

        # 1. Sunset / Deprecated check
        if feature.stage == FeatureStage.SUNSET:
            return FlagEvaluation(
                key=key,
                enabled=False,
                stage=FeatureStage.SUNSET,
                reason=EvaluationReason.SUNSET_DEPRECATED,
            )

        # 2. Allowlist override check
        if user_id_hash and user_id_hash in feature.allowlist:
            return FlagEvaluation(
                key=key,
                enabled=True,
                stage=feature.stage,
                reason=EvaluationReason.ALLOWLIST_OVERRIDE,
            )

        # 3. GA check
        if feature.stage == FeatureStage.GA:
            return FlagEvaluation(
                key=key,
                enabled=True,
                stage=FeatureStage.GA,
                reason=EvaluationReason.GA_ROLLOUT,
            )

        # 4. Dark launch check (0% public traffic)
        if feature.stage == FeatureStage.DARK_LAUNCH:
            return FlagEvaluation(
                key=key,
                enabled=False,
                stage=FeatureStage.DARK_LAUNCH,
                reason=EvaluationReason.DEFAULT_OFF,
            )

        # 5. Percentage-based Canary / Beta consistent bucketing
        bucket = self.compute_bucket(user_id_hash or "anonymous", key)
        is_active = bucket < feature.rollout_percentage
        return FlagEvaluation(
            key=key,
            enabled=is_active,
            stage=feature.stage,
            reason=EvaluationReason.PERCENTAGE_BUCKET if is_active else EvaluationReason.DEFAULT_OFF,
            bucket=bucket,
        )

    def evaluate_all(self, user_id_hash: str) -> Dict[str, FlagEvaluation]:
        return {key: self.evaluate(key, user_id_hash) for key in self._registry}

    def get_snapshot(self, user_id_hash: str) -> Dict[str, Any]:
        """
        Produce client-ready snapshot with flat boolean capability flags
        and rich enterprise audit telemetry.
        """
        evaluations = self.evaluate_all(user_id_hash)

        # High-level domain capability flags mapped to standard client contract
        flat_flags = {
            "voice_enabled": evaluations["voice.realtime"].enabled,
            "memory_enabled": evaluations["memory.graph_sync"].enabled,
            "pro_model_enabled": evaluations["intelligence.pro_models"].enabled,
            "changelog_enabled": evaluations["release.changelog"].enabled,
            "clinical_guidance": evaluations["clinical.guidance"].enabled,
            "analytics_insights": evaluations["analytics.insights"].enabled,
        }

        # Rich telemetry payload for internal observability / DevTools
        telemetry = {
            key: {
                "enabled": ev.enabled,
                "stage": ev.stage.value,
                "reason": ev.reason.value,
                "bucket": ev.bucket,
            }
            for key, ev in evaluations.items()
        }

        return {
            "user_id_hash": user_id_hash,
            "flags": flat_flags,
            "evaluations": telemetry,
            # Top-level capability mirrors for direct destructuring
            **flat_flags,
        }
