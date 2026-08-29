# backend/features/memory/routes.py

"""
Memory CRUD and Graph V3 synchronization HTTP endpoints.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from .schemas import MemoryAtom, MemoryGraph

router = APIRouter(prefix="/api/memory", tags=["memory"])


class MemoryGraphSavePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    graph: MemoryGraph
    expected_version: int | None = Field(default=None, ge=1)


class MemorySearchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    query: str = Field(min_length=1, max_length=200)
    category: str | None = None


@router.get("/v3")
async def load_memory_v3(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        graph = await services.memory.load_graph(context.session.user_id_hash)
        return {"loaded": True, "graph": graph.model_dump(mode="json")}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "memory_graph_load_failed", "message": "Failed to load memory graph", "request_id": context.request_id},
        ) from exc


@router.put("/v3")
async def save_memory_v3(
    payload: MemoryGraphSavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        await services.memory.save_graph(context.session.user_id_hash, payload.graph)
        return {"success": True, "version": payload.graph.version}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "memory_graph_save_failed", "message": "Failed to save memory graph", "request_id": context.request_id},
        ) from exc


@router.post("/search")
async def search_memory(
    payload: MemorySearchPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    results = await services.memory.search(
        user_id=context.session.user_id_hash,
        query=payload.query,
        category=payload.category,
    )
    return {"query": payload.query, "results": results, "count": len(results)}
