# backend/models/feature_flags.py

"""
Backward-compatibility facade for feature flags domain models.
"""

from backend.features.flags.schemas import (
    BUILTIN_FEATURES,
    EvaluationContext,
    FEATURE_REGISTRY,
    REGISTRY_VERSION,
    FeatureAdminUpdate,
    FeatureAdminUpdateRequest,
    FeatureContext,
    FeatureDecision,
    FeatureEvaluation,
    FeatureEvaluationPublic,
    FeatureLifecycle,
    FeaturePolicy,
    FeaturePolicyDocument,
    FeaturePublicItem,
    FeaturePublicSnapshot,
    FeatureReason,
    FeatureSpec,
    get_all_feature_specs,
    get_feature_spec,
)

__all__ = [
    "BUILTIN_FEATURES",
    "EvaluationContext",
    "FEATURE_REGISTRY",
    "REGISTRY_VERSION",
    "FeatureAdminUpdate",
    "FeatureAdminUpdateRequest",
    "FeatureContext",
    "FeatureDecision",
    "FeatureEvaluation",
    "FeatureEvaluationPublic",
    "FeatureLifecycle",
    "FeaturePolicy",
    "FeaturePolicyDocument",
    "FeaturePublicItem",
    "FeaturePublicSnapshot",
    "FeatureReason",
    "FeatureSpec",
    "get_all_feature_specs",
    "get_feature_spec",
]
