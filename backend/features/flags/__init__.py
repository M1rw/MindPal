# backend/features/flags/__init__.py

"""
Feature flags public exports gatekeeper.
Routes are registered separately by the app factory to avoid circular imports.
"""

from .repo import FeaturePolicyRepository, InMemoryFeaturePolicyRepository
from .schemas import (
    BUILTIN_FEATURES,
    EvaluationContext,
    FeatureAdminUpdateRequest,
    FeatureDecision,
    FeatureLifecycle,
    FeaturePolicy,
    FeaturePublicItem,
    FeaturePublicSnapshot,
    FeatureReason,
    FeatureSpec,
    get_all_feature_specs,
    get_feature_spec,
)
from .service import FeatureFlagsService

__all__ = [
    "BUILTIN_FEATURES",
    "EvaluationContext",
    "FeatureAdminUpdateRequest",
    "FeatureDecision",
    "FeatureFlagsService",
    "FeatureLifecycle",
    "FeaturePolicy",
    "FeaturePolicyRepository",
    "FeaturePublicItem",
    "FeaturePublicSnapshot",
    "FeatureReason",
    "FeatureSpec",
    "InMemoryFeaturePolicyRepository",
    "get_all_feature_specs",
    "get_feature_spec",
]
