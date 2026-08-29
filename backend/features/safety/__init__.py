# backend/features/safety/__init__.py

"""
Safety feature public exports gatekeeper.
"""

from .output_guard import OutputGuardService
from .pattern_matcher import CompiledSafetyRule, load_safety_rules
from .routes import SafetyCheckPayload, router
from .schemas import (
    CrisisResponseTemplate,
    OutputGuardDecision,
    SafetyAction,
    SafetyDecision,
    SafetyLevel,
    SafetyMatchedRule,
    SafetySource,
)
from .service import SafetyService

__all__ = [
    "CompiledSafetyRule",
    "CrisisResponseTemplate",
    "OutputGuardDecision",
    "OutputGuardService",
    "SafetyAction",
    "SafetyCheckPayload",
    "SafetyDecision",
    "SafetyLevel",
    "SafetyMatchedRule",
    "SafetyService",
    "SafetySource",
    "load_safety_rules",
    "router",
]
