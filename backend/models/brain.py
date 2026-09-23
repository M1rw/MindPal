from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class BrainNodeView(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str = Field(min_length=1)
    node_type: str = "context"
    category: str = "facts"
    title: str = ""
    summary: str = ""
    confidence: float = 0.0
    sensitivity: str = "low"
    source: str = "system"
    pinned: bool = False
    evidence_count: int = 0
    aliases: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None
    last_confirmed_at: str | None = None
    hidden_from_replies: bool = False


class BrainEdgeView(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str = Field(min_length=1)
    source_atom_id: str = Field(min_length=1)
    target_atom_id: str = Field(min_length=1)
    relation: str = "relates_to"
    confidence: float = 0.0
    tentative: bool = False
    created_at: str | None = None
    last_confirmed_at: str | None = None


class BrainContextNode(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str = Field(min_length=1)
    node_type: str = "context"
    text: str = ""
    confidence: float = 0.0
    last_confirmed_at: str | None = None
    why_selected: str = ""


class BrainContextEvidence(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    node_id: str = Field(min_length=1)
    evidence_id: str = Field(min_length=1)
    excerpt: str = ""
    captured_at: str | None = None


class BrainMapView(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    graph_version: int = 1
    scope: str = "global"
    focus_atom_id: str | None = None
    depth: int = 1
    nodes: list[BrainNodeView] = Field(default_factory=list)
    edges: list[BrainEdgeView] = Field(default_factory=list)
    generated_at: str | None = None


class BrainContextPack(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    graph_version: int = 1
    intent: str = "general_support"
    policy_tier: str = "standard"
    nodes: list[BrainContextNode] = Field(default_factory=list)
    evidence: list[BrainContextEvidence] = Field(default_factory=list)
    edges: list[BrainEdgeView] = Field(default_factory=list)
    conflicts: list[dict] = Field(default_factory=list)
    candidate_count: int = 0
    cache_hit: bool = False
    planner_latency_ms: float = 0.0


class BrainOverview(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    graph_version: int = 1
    visible_node_count: int = 0
    visible_edge_count: int = 0
    pending_review_count: int = 0
    pinned_nodes: list[BrainNodeView] = Field(default_factory=list)
    recent_patterns: list[BrainNodeView] = Field(default_factory=list)
    suggested_tools: list[BrainNodeView] = Field(default_factory=list)
    stale_node_ids: list[str] = Field(default_factory=list)
    generated_at: str | None = None
