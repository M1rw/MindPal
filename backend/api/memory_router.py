# backend/api/memory_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import normalize_locale, sanitize_text
from backend.models.memory import (
    MemoryAtom,
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryGraph,
    MemoryGraphLoadResult,
    MemoryGraphPatch,
    MemoryGraphWriteResult,
    MemoryInteraction,
    MemoryLoadResult,
    MemorySummary,
    MemoryWriteResult,
    memory_graph_from_summary,
    summary_from_memory_graph,
)
from backend.services.memory_graph_service import (
    delete_memory_atom,
    merge_memory_graph,
)


router = APIRouter(prefix="/api/memory", tags=["memory"])

MAX_MEMORY_INTERACTIONS = 50
MAX_CLIENT_MEMORY_ITEMS = 80
MAX_SESSION_HASH_CHARS = 120


class MemorySummarizePayload(BaseModel):
    """
    Explicit memory compaction payload.

    user_id_hash is intentionally absent. The route always uses the verified
    Firebase session hash to prevent client-side spoofing.

    This route requires authentication.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    interactions: list[MemoryInteraction] = Field(
        default_factory=list,
        max_length=MAX_MEMORY_INTERACTIONS,
    )
    force: bool = False
    save: bool = True
    locale: str = "auto"

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))


class MemorySavePayload(BaseModel):
    """
    Explicit memory overwrite/update payload.

    The submitted summary is re-bound to the verified Firebase session hash
    before persistence.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    summary: MemorySummary


class MemoryGraphSavePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph: MemoryGraph
    also_update_summary: bool = True


class MemoryGraphPatchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    patch: MemoryGraphPatch
    also_update_summary: bool = True


class MemoryGraphMergePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    graph: MemoryGraph | None = None
    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_CLIENT_MEMORY_ITEMS)
    also_update_summary: bool = True


@router.get("/v3", response_model=MemoryGraphLoadResult)
async def load_memory_v3(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)

    try:
        loaded = await services.db.load_memory_graph(context.session.user_id_hash)
        if loaded.loaded and loaded.graph:
            return loaded

        legacy = await services.db.load_memory(context.session.user_id_hash)
        if legacy.summary:
            graph = memory_graph_from_summary(legacy.summary)
            graph = _graph_for_session(graph, user_id_hash=context.session.user_id_hash)
            await services.db.save_memory_graph(graph)
            return MemoryGraphLoadResult(
                user_id_hash=context.session.user_id_hash,
                loaded=True,
                graph=graph,
                migrated_from_summary=True,
                provider=loaded.provider,
            )

        return loaded

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_load_failed",
                "message": "Failed to load memory graph",
                "request_id": context.request_id,
            },
        ) from exc


@router.put("/v3", response_model=MemoryGraphWriteResult)
async def save_memory_v3(
    payload: MemoryGraphSavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphWriteResult:
    assert_authenticated(context)

    try:
        graph = _graph_for_session(payload.graph, user_id_hash=context.session.user_id_hash)
        result = await services.db.save_memory_graph(graph)
        if payload.also_update_summary:
            await services.db.save_memory(summary_from_memory_graph(graph))
        return result

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_save_failed",
                "message": "Failed to save memory graph",
                "request_id": context.request_id,
            },
        ) from exc


@router.patch("/v3", response_model=MemoryGraphLoadResult)
async def patch_memory_v3(
    payload: MemoryGraphPatchPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)

    try:
        existing = await _load_or_migrate_graph(services, context.session.user_id_hash)
        graph = existing
        for atom_id in payload.patch.deleted_atom_ids:
            graph = delete_memory_atom(graph, atom_id, tombstone=True)
        graph = merge_memory_graph(graph, payload.patch.atoms)
        graph = _graph_for_session(graph, user_id_hash=context.session.user_id_hash)
        await services.db.save_memory_graph(graph)
        if payload.also_update_summary:
            await services.db.save_memory(summary_from_memory_graph(graph))
        return MemoryGraphLoadResult(
            user_id_hash=context.session.user_id_hash,
            loaded=True,
            graph=graph,
            provider=services.db.provider.name,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_patch_failed",
                "message": "Failed to patch memory graph",
                "request_id": context.request_id,
            },
        ) from exc


@router.delete("/v3/items/{atom_id}", response_model=MemoryGraphLoadResult)
async def delete_memory_v3_item(
    atom_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)

    try:
        graph = await _load_or_migrate_graph(services, context.session.user_id_hash)
        graph = delete_memory_atom(graph, sanitize_text(atom_id, 160), tombstone=True)
        await services.db.save_memory_graph(graph)
        await services.db.save_memory(summary_from_memory_graph(graph))
        return MemoryGraphLoadResult(
            user_id_hash=context.session.user_id_hash,
            loaded=True,
            graph=graph,
            provider=services.db.provider.name,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_delete_item_failed",
                "message": "Failed to delete memory graph item",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/v3/merge", response_model=MemoryGraphLoadResult)
async def merge_memory_v3(
    payload: MemoryGraphMergePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)

    try:
        existing = await _load_or_migrate_graph(services, context.session.user_id_hash)
        incoming = payload.graph or payload.atoms
        graph = merge_memory_graph(existing, incoming)
        graph = _graph_for_session(graph, user_id_hash=context.session.user_id_hash)
        await services.db.save_memory_graph(graph)
        if payload.also_update_summary:
            await services.db.save_memory(summary_from_memory_graph(graph))
        return MemoryGraphLoadResult(
            user_id_hash=context.session.user_id_hash,
            loaded=True,
            graph=graph,
            provider=services.db.provider.name,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_merge_failed",
                "message": "Failed to merge memory graph",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/v3/migrate", response_model=MemoryGraphLoadResult)
async def migrate_memory_v3(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)

    try:
        graph = await _load_or_migrate_graph(services, context.session.user_id_hash)
        await services.db.save_memory_graph(graph)
        return MemoryGraphLoadResult(
            user_id_hash=context.session.user_id_hash,
            loaded=True,
            graph=graph,
            migrated_from_summary=True,
            provider=services.db.provider.name,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_graph_migrate_failed",
                "message": "Failed to migrate memory graph",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("", response_model=MemoryLoadResult)
async def load_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryLoadResult:
    """
    Load the authenticated user's memory summary.

    Does not expose memory for arbitrary user IDs.
    Anonymous sessions are not allowed.
    """
    assert_authenticated(context)

    try:
        return await services.db.load_memory(context.session.user_id_hash)

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_load_failed",
                "message": "Failed to load memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/summarize", response_model=MemoryCompactionResult)
async def summarize_memory(
    payload: MemorySummarizePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryCompactionResult:
    """
    Compact sanitized interaction fragments into authenticated user memory.

    Flow:
    - require verified Firebase session
    - load existing memory for current session
    - run LLM-primary memory compaction with local fallback
    - optionally persist only if changed and save=true
    """
    assert_authenticated(context)

    try:
        locale = payload.locale if payload.locale != "auto" else context.locale

        existing = await services.db.load_memory(context.session.user_id_hash)
        existing_summary = existing.summary

        compaction = await services.memory.compact(
            MemoryCompactionRequest(
                request_id=context.request_id,
                user_id_hash=context.session.user_id_hash,
                existing_summary=existing_summary,
                interactions=payload.interactions,
                locale=locale,
                force=payload.force,
            )
        )

        if payload.save and compaction.changed:
            safe_summary = _summary_for_session(
                compaction.summary,
                user_id_hash=context.session.user_id_hash,
            )
            await services.db.save_memory(safe_summary)

        return compaction

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_summarize_failed",
                "message": "Failed to summarize memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.put("", response_model=MemoryWriteResult)
async def save_memory(
    payload: MemorySavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    """
    Save/replace the authenticated user's memory summary.

    The client cannot choose the target user hash. The submitted summary is
    always re-bound to context.session.user_id_hash.
    """
    assert_authenticated(context)

    try:
        summary = _summary_for_session(
            payload.summary,
            user_id_hash=context.session.user_id_hash,
        )
        return await services.db.save_memory(summary)

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_save_failed",
                "message": "Failed to save memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.delete("", response_model=MemoryWriteResult)
async def delete_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    """
    Delete the authenticated user's memory summary.
    """
    assert_authenticated(context)

    try:
        return await services.db.delete_memory(context.session.user_id_hash)

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_delete_failed",
                "message": "Failed to delete memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("/health")
async def memory_health(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """
    Memory subsystem health.

    Does not return memory contents. Auth is still required because this route
    belongs to the memory surface.
    """
    assert_authenticated(context)

    return {
        "request_id": context.request_id,
        "authenticated": True,
        "memory": services.memory.health(),
    }


def _summary_for_session(summary: MemorySummary, *, user_id_hash: str) -> MemorySummary:
    """
    Rebind a MemorySummary to the authenticated session user.

    This prevents a client from submitting a summary for another user_id_hash.
    Uses model_copy to preserve model fields added later.
    """
    clean_user_hash = sanitize_text(user_id_hash, MAX_SESSION_HASH_CHARS)

    if not clean_user_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_authenticated_session",
                "message": "Authenticated session is missing a stable user hash",
            },
        )

    return summary.model_copy(
        update={
            "user_id_hash": clean_user_hash,
            "important_people": summary.important_people[:MAX_CLIENT_MEMORY_ITEMS],
            "relationship_facts": summary.relationship_facts[:MAX_CLIENT_MEMORY_ITEMS],
            "emotional_triggers": summary.emotional_triggers[:MAX_CLIENT_MEMORY_ITEMS],
            "user_goals": summary.user_goals[:MAX_CLIENT_MEMORY_ITEMS],
            "avoided_responses": summary.avoided_responses[:MAX_CLIENT_MEMORY_ITEMS],
            "known_triggers": summary.known_triggers[:MAX_CLIENT_MEMORY_ITEMS],
            "preferred_coping_tools": summary.preferred_coping_tools[:MAX_CLIENT_MEMORY_ITEMS],
            "goals": summary.goals[:MAX_CLIENT_MEMORY_ITEMS],
            "preferences": summary.preferences[:MAX_CLIENT_MEMORY_ITEMS],
            "safety_flags": summary.safety_flags[:MAX_CLIENT_MEMORY_ITEMS],
            "items": summary.items[:MAX_CLIENT_MEMORY_ITEMS],
            "version": max(1, summary.version),
        }
    )


async def _load_or_migrate_graph(services: Any, user_id_hash: str) -> MemoryGraph:
    loaded = await services.db.load_memory_graph(user_id_hash)

    if loaded.loaded and loaded.graph:
        return _graph_for_session(loaded.graph, user_id_hash=user_id_hash)

    legacy = await services.db.load_memory(user_id_hash)
    if legacy.summary:
        return _graph_for_session(memory_graph_from_summary(legacy.summary), user_id_hash=user_id_hash)

    return MemoryGraph(user_id_hash=user_id_hash)


def _graph_for_session(graph: MemoryGraph, *, user_id_hash: str) -> MemoryGraph:
    clean_user_hash = sanitize_text(user_id_hash, MAX_SESSION_HASH_CHARS)

    if not clean_user_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_authenticated_session",
                "message": "Authenticated session is missing a stable user hash",
            },
        )

    return graph.model_copy(
        update={
            "user_id_hash": clean_user_hash,
            "atoms": graph.atoms[:MAX_CLIENT_MEMORY_ITEMS],
            "version": max(1, graph.version),
            "full_snapshot": True,
        }
    )


