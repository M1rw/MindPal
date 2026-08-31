"""Authenticated, policy-filtered API routes for the MindPal Obsidian Brain."""

from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.models._helpers import utcnow
from backend.models.brain import (
    MAX_BRAIN_QUERY_CHARS,
    BrainContextPack,
    BrainEdgeView,
    BrainFocusView,
    BrainMapView,
    BrainNodeView,
    BrainOverview,
    BrainPolicyTier,
)
from backend.models.memory import (
    BrainEdge,
    BrainEdgeStatus,
    BrainEdgeType,
    BrainReviewStatus,
    MemoryCategory,
    MemoryGraph,
    MemoryStatus,
)


router = APIRouter(prefix="/api/brain", tags=["brain"])
MAX_EDGE_REASON_CHARS = 240


class BrainEdgeCreatePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    source_atom_id: str = Field(min_length=1, max_length=160)
    target_atom_id: str = Field(min_length=1, max_length=160)
    relation: BrainEdgeType
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)
    expected_version: int | None = Field(default=None, ge=1)

    @field_validator("source_atom_id", "target_atom_id", mode="before")
    @classmethod
    def _clean_id(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 160)
        if not cleaned:
            raise ValueError("Brain atom ID cannot be empty")
        return cleaned


class BrainEdgePatchAction(str, Enum):
    CONFIRM = "confirm"
    HIDE = "hide"
    REMOVE = "remove"


class BrainEdgePatchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    action: BrainEdgePatchAction
    expected_version: int | None = Field(default=None, ge=1)


class BrainReviewAction(str, Enum):
    CONFIRM = "confirm"
    DISMISS = "dismiss"
    DEFER = "defer"
    PIN = "pin"
    FORGET = "forget"


class BrainReviewActionPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    action: BrainReviewAction
    expected_version: int | None = Field(default=None, ge=1)


class BrainContextPlanPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    query: str = Field(default="", max_length=MAX_BRAIN_QUERY_CHARS)
    intent: str = Field(default="general_support", max_length=120)
    session_entity_ids: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("query", "intent", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        return sanitize_text(str(value or ""), MAX_BRAIN_QUERY_CHARS)

    @field_validator("session_entity_ids", mode="before")
    @classmethod
    def _clean_ids(cls, value: object) -> list[str]:
        raw = value if isinstance(value, list) else []
        output: list[str] = []
        for item in raw[:12]:
            cleaned = sanitize_text(str(item or ""), 160)
            if cleaned and cleaned not in output:
                output.append(cleaned)
        return output


class BrainMutationResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph_version: int = Field(ge=1)
    changed: bool
    edge: BrainEdgeView | None = None
    review_id: str | None = Field(default=None, max_length=160)


@router.get("/overview", response_model=BrainOverview)
async def brain_overview(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainOverview:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        return services.brain.overview(graph)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("brain_overview_failed", "Failed to load Brain overview", context.request_id, exc)


@router.get("/map", response_model=BrainMapView)
async def brain_map(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
    focus_atom_id: str | None = Query(default=None, max_length=160),
    depth: int = Query(default=1, ge=0, le=2),
    categories: str | None = Query(default=None, max_length=300),
) -> BrainMapView:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        clean_focus = sanitize_text(focus_atom_id or "", 160) or None
        return services.brain.map_view(
            graph,
            focus_atom_id=clean_focus,
            depth=depth,
            categories=_parse_categories(categories),
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_map_failed", "Failed to load Brain map", context.request_id, exc)


@router.get("/nodes/{atom_id}", response_model=BrainFocusView)
async def brain_focus(
    atom_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainFocusView:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        clean_id = _clean_atom_id(atom_id)
        node = _visible_node_or_404(graph, clean_id, services)
        local_map = services.brain.map_view(graph, focus_atom_id=clean_id, depth=1)
        evidence = services.brain.evidence_views(graph, {clean_id}, policy_tier=BrainPolicyTier.STANDARD)
        return BrainFocusView(
            node=node,
            evidence=evidence,
            backlinks=services.brain.backlinks(graph, clean_id),
            local_map=local_map,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_focus_failed", "Failed to load Brain item", context.request_id, exc)


@router.get("/search", response_model=list[BrainNodeView])
async def brain_search(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
    q: str = Query(min_length=1, max_length=MAX_BRAIN_QUERY_CHARS),
    categories: str | None = Query(default=None, max_length=300),
    limit: int = Query(default=30, ge=1, le=100),
) -> list[BrainNodeView]:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        query = sanitize_text(q, MAX_BRAIN_QUERY_CHARS)
        if not query:
            raise HTTPException(status_code=422, detail={"code": "invalid_brain_query", "message": "Search query is required"})
        return services.brain.search(graph, query, categories=_parse_categories(categories), limit=limit)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_search_failed", "Failed to search Brain", context.request_id, exc)


@router.post("/edges", response_model=BrainMutationResponse, status_code=status.HTTP_201_CREATED)
async def create_brain_edge(
    payload: BrainEdgeCreatePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainMutationResponse:
    assert_authenticated(context)
    try:
        await _limit_brain_write(services, context)
        edge = BrainEdge(
            id=f"edge_{uuid4().hex}",
            source_atom_id=payload.source_atom_id,
            target_atom_id=payload.target_atom_id,
            relation=payload.relation,
            confidence=payload.confidence,
        )

        def mutate(graph: MemoryGraph) -> MemoryGraph:
            _require_active_endpoint(graph, edge.source_atom_id)
            _require_active_endpoint(graph, edge.target_atom_id)
            if any(
                item.status != BrainEdgeStatus.DELETED
                and item.source_atom_id == edge.source_atom_id
                and item.target_atom_id == edge.target_atom_id
                and item.relation == edge.relation
                for item in graph.brain.edges
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "duplicate_brain_edge", "message": "This Brain link already exists"},
                )
            brain = graph.brain.model_copy(update={"edges": [*graph.brain.edges, edge], "updated_at": utcnow()})
            return graph.model_copy(update={"brain": brain})

        result = await services.memory_repo.update_brain(
            user_id_hash=context.session.user_id_hash,
            mutate=mutate,
            expected_version=payload.expected_version,
        )
        services.brain.invalidate_graph(result.snapshot.version - 1)
        persisted = next(item for item in result.snapshot.brain.edges if item.id == edge.id)
        return BrainMutationResponse(graph_version=result.snapshot.version, changed=result.changed, edge=services.brain.edge_view(persisted))
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_edge_create_failed", "Failed to create Brain link", context.request_id, exc)


@router.patch("/edges/{edge_id}", response_model=BrainMutationResponse)
async def update_brain_edge(
    edge_id: str,
    payload: BrainEdgePatchPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainMutationResponse:
    assert_authenticated(context)
    try:
        await _limit_brain_write(services, context)
        clean_id = _clean_edge_id(edge_id)
        updated_edge: BrainEdge | None = None

        def mutate(graph: MemoryGraph) -> MemoryGraph:
            nonlocal updated_edge
            output: list[BrainEdge] = []
            for edge in graph.brain.edges:
                if edge.id != clean_id:
                    output.append(edge)
                    continue
                if payload.action == BrainEdgePatchAction.CONFIRM:
                    updated_edge = edge.model_copy(update={"confidence": 1.0, "last_confirmed_at": utcnow(), "updated_at": utcnow()})
                elif payload.action == BrainEdgePatchAction.HIDE:
                    updated_edge = edge.model_copy(update={"status": BrainEdgeStatus.HIDDEN, "updated_at": utcnow()})
                else:
                    updated_edge = edge.model_copy(update={"status": BrainEdgeStatus.DELETED, "updated_at": utcnow()})
                output.append(updated_edge)
            if updated_edge is None:
                raise HTTPException(status_code=404, detail={"code": "brain_edge_not_found", "message": "Brain link was not found"})
            brain = graph.brain.model_copy(update={"edges": output, "updated_at": utcnow()})
            return graph.model_copy(update={"brain": brain})

        result = await services.memory_repo.update_brain(
            user_id_hash=context.session.user_id_hash,
            mutate=mutate,
            expected_version=payload.expected_version,
        )
        services.brain.invalidate_graph(result.snapshot.version - 1)
        return BrainMutationResponse(
            graph_version=result.snapshot.version,
            changed=result.changed,
            edge=services.brain.edge_view(updated_edge) if updated_edge else None,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_edge_update_failed", "Failed to update Brain link", context.request_id, exc)


@router.delete("/edges/{edge_id}", response_model=BrainMutationResponse)
async def remove_brain_edge(
    edge_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
    expected_version: int | None = Query(default=None, ge=1),
) -> BrainMutationResponse:
    return await update_brain_edge(
        edge_id,
        BrainEdgePatchPayload(action=BrainEdgePatchAction.REMOVE, expected_version=expected_version),
        services,
        context,
    )


@router.post("/review/{review_id}", response_model=BrainMutationResponse)
async def resolve_brain_review(
    review_id: str,
    payload: BrainReviewActionPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainMutationResponse:
    assert_authenticated(context)
    try:
        await _limit_brain_write(services, context)
        clean_id = _clean_edge_id(review_id)

        def mutate(graph: MemoryGraph) -> MemoryGraph:
            target = next((item for item in graph.brain.review_queue if item.id == clean_id), None)
            if target is None:
                raise HTTPException(status_code=404, detail={"code": "brain_review_not_found", "message": "Brain review item was not found"})
            status_value = {
                BrainReviewAction.CONFIRM: BrainReviewStatus.CONFIRMED,
                BrainReviewAction.DISMISS: BrainReviewStatus.DISMISSED,
                BrainReviewAction.DEFER: BrainReviewStatus.DEFERRED,
                BrainReviewAction.PIN: BrainReviewStatus.CONFIRMED,
                BrainReviewAction.FORGET: BrainReviewStatus.DISMISSED,
            }[payload.action]
            now = utcnow()
            reviews = [
                item.model_copy(update={"status": status_value, "updated_at": now}) if item.id == clean_id else item
                for item in graph.brain.review_queue
            ]
            atoms = graph.atoms
            if payload.action in {BrainReviewAction.PIN, BrainReviewAction.FORGET}:
                atoms = [
                    atom.model_copy(
                        update={
                            "pinned": payload.action == BrainReviewAction.PIN,
                            "status": MemoryStatus.DELETED if payload.action == BrainReviewAction.FORGET else atom.status,
                            "updated_at": now,
                            "last_seen_at": now,
                        }
                    )
                    if atom.id == target.atom_id
                    else atom
                    for atom in graph.atoms
                ]
            brain = graph.brain.model_copy(update={"review_queue": reviews, "updated_at": now})
            return graph.model_copy(update={"atoms": atoms, "brain": brain})

        result = await services.memory_repo.update_brain(
            user_id_hash=context.session.user_id_hash,
            mutate=mutate,
            expected_version=payload.expected_version,
        )
        services.brain.invalidate_graph(result.snapshot.version - 1)
        return BrainMutationResponse(graph_version=result.snapshot.version, changed=result.changed, review_id=clean_id)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("brain_review_update_failed", "Failed to update Brain review", context.request_id, exc)


@router.post("/context-plan", response_model=BrainContextPack)
async def brain_context_plan(
    payload: BrainContextPlanPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainContextPack:
    """Return the explainable, policy-filtered context that standard chat may use."""
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        return services.brain.plan_context(
            graph,
            payload.query,
            intent=payload.intent,
            policy_tier=BrainPolicyTier.STANDARD,
            session_entity_ids=payload.session_entity_ids,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("brain_context_plan_failed", "Failed to build Brain context", context.request_id, exc)


def _parse_categories(value: str | None) -> set[MemoryCategory] | None:
    if not value:
        return None
    output: set[MemoryCategory] = set()
    for raw in value.split(","):
        cleaned = sanitize_text(raw, 80).lower()
        if not cleaned:
            continue
        try:
            output.add(MemoryCategory(cleaned))
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={"code": "invalid_brain_category", "message": "Unknown Brain category"},
            ) from exc
    return output or None


def _clean_atom_id(value: str) -> str:
    cleaned = sanitize_text(value, 160)
    if not cleaned:
        raise HTTPException(status_code=422, detail={"code": "invalid_brain_atom_id", "message": "Invalid Brain item ID"})
    return cleaned


def _clean_edge_id(value: str) -> str:
    cleaned = sanitize_text(value, 160)
    if not cleaned:
        raise HTTPException(status_code=422, detail={"code": "invalid_brain_record_id", "message": "Invalid Brain record ID"})
    return cleaned


def _visible_node_or_404(graph: MemoryGraph, atom_id: str, services: Any) -> BrainNodeView:
    atom = next((item for item in graph.atoms if item.id == atom_id), None)
    if atom is None or not services.brain.is_visible(atom, BrainPolicyTier.STANDARD):
        raise HTTPException(status_code=404, detail={"code": "brain_node_not_found", "message": "Brain item was not found"})
    return services.brain.node_view(atom)


def _require_active_endpoint(graph: MemoryGraph, atom_id: str) -> None:
    atom = next((item for item in graph.atoms if item.id == atom_id), None)
    if atom is None or atom.status != MemoryStatus.ACTIVE:
        raise HTTPException(status_code=422, detail={"code": "invalid_brain_edge_endpoint", "message": "Brain links require active memory items"})


async def _limit_brain_write(services: Any, context: Any) -> None:
    await services.rate_limits.consume(
        scope="memory_write",
        subject=context.session.user_id_hash,
        limit=services.settings.MEMORY_WRITE_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )


def _internal_error(code: str, message: str, request_id: str, exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": code, "message": message, "request_id": request_id},
    )
