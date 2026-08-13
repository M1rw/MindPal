"""Public, policy-filtered view models for the MindPal Obsidian Brain."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import sanitize_text
from backend.models._helpers import utcnow
from backend.models.memory import BrainEdgeType, MemoryCategory, MemorySensitivity


MAX_BRAIN_QUERY_CHARS = 500
MAX_BRAIN_RESULTS = 100
MAX_BRAIN_MAP_DEPTH = 2
MAX_CONTEXT_NODES = 6
MAX_CONTEXT_EVIDENCE = 2
MAX_CONTEXT_EDGES = 8


class BrainNodeType(str, Enum):
    PERSON = "person"
    GOAL = "goal"
    PATTERN = "pattern"
    COPING_TOOL = "coping_tool"
    PREFERENCE = "preference"
    CONTEXT = "context"
    REFLECTION = "reflection"
    SESSION_SUMMARY = "session_summary"
    BOUNDARY = "boundary"
    SAFETY_CONTEXT = "safety_context"


class BrainPolicyTier(str, Enum):
    STANDARD = "standard"
    SENSITIVE = "sensitive"
    RESTRICTED = "restricted"


class BrainNodeView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    node_type: BrainNodeType
    category: MemoryCategory
    title: str = Field(min_length=1, max_length=180)
    summary: str = Field(min_length=1, max_length=700)
    confidence: float = Field(ge=0.0, le=1.0)
    sensitivity: MemorySensitivity
    source: str = Field(min_length=1, max_length=80)
    pinned: bool = False
    evidence_count: int = Field(default=0, ge=0)
    aliases: list[str] = Field(default_factory=list, max_length=30)
    created_at: datetime
    updated_at: datetime
    last_confirmed_at: datetime | None = None
    hidden_from_replies: bool = False

    @field_validator("id", "title", "summary", "source", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 700)
        if not cleaned:
            raise ValueError("Brain node text cannot be empty")
        return cleaned


class BrainEdgeView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    source_atom_id: str = Field(min_length=1, max_length=160)
    target_atom_id: str = Field(min_length=1, max_length=160)
    relation: BrainEdgeType
    confidence: float = Field(ge=0.0, le=1.0)
    tentative: bool = False
    created_at: datetime
    last_confirmed_at: datetime | None = None


class BrainEvidenceView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    atom_id: str = Field(min_length=1, max_length=160)
    excerpt: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=80)
    captured_at: datetime


class BrainMapView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph_version: int = Field(ge=1)
    scope: str = Field(default="global", pattern="^(global|local)$")
    focus_atom_id: str | None = Field(default=None, max_length=160)
    depth: int = Field(default=1, ge=0, le=MAX_BRAIN_MAP_DEPTH)
    nodes: list[BrainNodeView] = Field(default_factory=list, max_length=MAX_BRAIN_RESULTS)
    edges: list[BrainEdgeView] = Field(default_factory=list, max_length=500)
    generated_at: datetime = Field(default_factory=utcnow)


class BrainContextNode(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    node_type: BrainNodeType
    text: str = Field(min_length=1, max_length=700)
    confidence: float = Field(ge=0.0, le=1.0)
    last_confirmed_at: datetime | None = None
    why_selected: str = Field(min_length=1, max_length=240)


class BrainContextEvidence(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    node_id: str = Field(min_length=1, max_length=160)
    evidence_id: str = Field(min_length=1, max_length=160)
    excerpt: str = Field(min_length=1, max_length=500)
    captured_at: datetime


class BrainConflict(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    edge_id: str = Field(min_length=1, max_length=160)
    source_atom_id: str = Field(min_length=1, max_length=160)
    target_atom_id: str = Field(min_length=1, max_length=160)
    reason: str = Field(default="Conflicting remembered items need review.", max_length=240)


class BrainContextPack(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph_version: int = Field(ge=1)
    intent: str = Field(default="general_support", max_length=120)
    policy_tier: BrainPolicyTier = BrainPolicyTier.STANDARD
    nodes: list[BrainContextNode] = Field(default_factory=list, max_length=MAX_CONTEXT_NODES)
    evidence: list[BrainContextEvidence] = Field(default_factory=list, max_length=MAX_CONTEXT_EVIDENCE)
    edges: list[BrainEdgeView] = Field(default_factory=list, max_length=MAX_CONTEXT_EDGES)
    conflicts: list[BrainConflict] = Field(default_factory=list, max_length=20)
    candidate_count: int = Field(default=0, ge=0, le=24)
    cache_hit: bool = False
    planner_latency_ms: float = Field(default=0.0, ge=0.0)


class BrainFocusView(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    node: BrainNodeView
    evidence: list[BrainEvidenceView] = Field(default_factory=list, max_length=50)
    backlinks: list[BrainEdgeView] = Field(default_factory=list, max_length=100)
    local_map: BrainMapView


class BrainOverview(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph_version: int = Field(ge=1)
    visible_node_count: int = Field(default=0, ge=0)
    visible_edge_count: int = Field(default=0, ge=0)
    pending_review_count: int = Field(default=0, ge=0)
    pinned_nodes: list[BrainNodeView] = Field(default_factory=list, max_length=6)
    recent_patterns: list[BrainNodeView] = Field(default_factory=list, max_length=6)
    suggested_tools: list[BrainNodeView] = Field(default_factory=list, max_length=6)
    stale_node_ids: list[str] = Field(default_factory=list, max_length=20)
    generated_at: datetime = Field(default_factory=utcnow)
