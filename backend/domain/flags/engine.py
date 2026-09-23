# backend/domain/flags/engine.py — Enterprise Feature Lifecycle & Consistent Bucketing Engine

from __future__ import annotations

import hashlib
from typing import Dict, Any, List, Optional, Set

from backend.configs.settings import get_settings
from backend.configs.runtime import behavior_config
from backend.domain.flags.models import (
    FeatureDefinition,
    FeatureStage,
    EvaluationReason,
    FlagEvaluation,
)

# Explicit kill switch only. Missing env, "1", "true", and "yes" all leave live
# duplex on. Production fail-closed is MINDPAL_VOICE_LIVE=0 (or false/no/off).
_FLAG_BEHAVIOR = behavior_config()["flags"]
_VOICE_LIVE_OFF = frozenset(_FLAG_BEHAVIOR["off_values"])
_ON_VALUES = frozenset(_FLAG_BEHAVIOR["on_values"])


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
    def _voice_live_enabled(cls) -> bool:
        raw = get_settings().voice_live.strip().lower()
        return raw not in _VOICE_LIVE_OFF

    @classmethod
    def _voice_realtime_definition(cls) -> FeatureDefinition:
        """Live duplex preview is on unless MINDPAL_VOICE_LIVE is an explicit off value."""
        allowlist: Set[str] = {
            item.strip()
            for item in get_settings().voice_live_allowlist.split(",")
            if item.strip()
        }
        if cls._voice_live_enabled():
            return FeatureDefinition(
                key="voice.realtime",
                stage=FeatureStage.CANARY,
                rollout_percentage=100,
                owner="voice-team",
                description="Preview Gemini Live duplex for signed-in accounts. Not general availability.",
                allowlist=allowlist,
            )
        return FeatureDefinition(
            key="voice.realtime",
            stage=FeatureStage.DARK_LAUNCH,
            rollout_percentage=0,
            owner="voice-team",
            description="Gemini Live duplex preview. Disabled via MINDPAL_VOICE_LIVE=0.",
            allowlist=allowlist,
        )

    @classmethod
    def _presence_definition(cls) -> FeatureDefinition:
        """The Presence surface. Dark by default and honest about it.

        The web client gates its Presence tab on a `presence_enabled` flag that
        the snapshot never emitted, so the tab was off for a reason no operator
        could see or change. The flag now exists with an explicit switch; the
        default stays off because the surface is still preview.
        """
        allowlist: Set[str] = {
            item.strip()
            for item in get_settings().presence_allowlist.split(",")
            if item.strip()
        }
        enabled = get_settings().presence.strip().lower() in _ON_VALUES
        return FeatureDefinition(
            key="voice.presence",
            stage=FeatureStage.CANARY if enabled else FeatureStage.DARK_LAUNCH,
            rollout_percentage=100 if enabled else 0,
            owner="voice-team",
            description="Presence surface preview. Enable with MINDPAL_PRESENCE=1.",
            allowlist=allowlist,
        )

    @classmethod
    def _default_capabilities(cls) -> List[FeatureDefinition]:
        """Canonical MindPal domain capabilities adhering to domain taxonomy."""
        return [
            cls._voice_realtime_definition(),
            cls._presence_definition(),
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

    @staticmethod
    def _enabled(evaluations: Dict[str, FlagEvaluation], key: str) -> bool:
        """A capability this engine does not define is off, not a KeyError.

        `get_snapshot` indexed the evaluation map directly, so constructing an
        engine with a narrower registry — which the tests and the kill-switch
        path both do — turned /api/features into a 500.
        """
        evaluation = evaluations.get(key)
        return bool(evaluation and evaluation.enabled)

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
            "voice_enabled": self._enabled(evaluations, "voice.realtime"),
            "presence_enabled": self._enabled(evaluations, "voice.presence"),
            "memory_enabled": self._enabled(evaluations, "memory.graph_sync"),
            "pro_model_enabled": self._enabled(evaluations, "intelligence.pro_models"),
            "changelog_enabled": self._enabled(evaluations, "release.changelog"),
            "clinical_guidance": self._enabled(evaluations, "clinical.guidance"),
            "analytics_insights": self._enabled(evaluations, "analytics.insights"),
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
