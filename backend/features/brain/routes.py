# backend/features/brain/routes.py

"""
Brain graph and cognitive context planning HTTP endpoints.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import AuthenticatedRequestContextDep, ServicesDep, assert_authenticated, http_error_from_app_error
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from .schemas import (
    MAX_BRAIN_QUERY_CHARS,
    BrainContextPack,
    BrainMapView,
    BrainPolicyTier,
)

router = APIRouter(prefix="/api/brain", tags=["brain"])


class BrainContextPlanPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    query: str = Field(default="", max_length=MAX_BRAIN_QUERY_CHARS)
    intent: str = Field(default="general_support", max_length=120)
    session_entity_ids: list[str] = Field(default_factory=list, max_length=12)


@router.get("/map", response_model=BrainMapView)
async def get_brain_map(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
    focus_atom_id: Annotated[str | None, Query(max_length=160)] = None,
    depth: Annotated[int, Query(ge=0, le=2)] = 1,
) -> BrainMapView:
    assert_authenticated(context)
    try:
        graph = await services.memory.load_graph(context.session.user_id_hash)
        return services.brain.build_map(graph, focus_atom_id=focus_atom_id, depth=depth)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "brain_map_failed", "message": "Failed to load brain map", "request_id": context.request_id},
        ) from exc


@router.post("/context/plan", response_model=BrainContextPack)
async def plan_brain_context(
    payload: BrainContextPlanPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> BrainContextPack:
    assert_authenticated(context)
    try:
        graph = await services.memory.load_graph(context.session.user_id_hash)
        return services.brain.plan_context(graph, payload.query)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "brain_plan_failed", "message": "Failed to plan brain context", "request_id": context.request_id},
        ) from exc
