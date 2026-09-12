# backend/features/brain/__init__.py

"""
Brain feature public exports gatekeeper.
"""

from .routes import BrainContextPlanPayload, router
from .schemas import (
    MAX_BRAIN_MAP_DEPTH,
    MAX_BRAIN_QUERY_CHARS,
    MAX_BRAIN_RESULTS,
    MAX_CONTEXT_EDGES,
    MAX_CONTEXT_EVIDENCE,
    MAX_CONTEXT_NODES,
    BrainContextPack,
    BrainEdgeView,
    BrainEvidenceView,
    BrainMapView,
    BrainNodeType,
    BrainNodeView,
    BrainPolicyTier,
)
from .service import BrainService, render_context_pack_for_prompt

__all__ = [
    "BrainContextPack",
    "BrainContextPlanPayload",
    "BrainEdgeView",
    "BrainEvidenceView",
    "BrainMapView",
    "BrainNodeType",
    "BrainNodeView",
    "BrainPolicyTier",
    "BrainService",
    "MAX_BRAIN_MAP_DEPTH",
    "MAX_BRAIN_QUERY_CHARS",
    "MAX_BRAIN_RESULTS",
    "MAX_CONTEXT_EDGES",
    "MAX_CONTEXT_EVIDENCE",
    "MAX_CONTEXT_NODES",
    "render_context_pack_for_prompt",
    "router",
]
