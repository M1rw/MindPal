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
    MemorySource,
    MemorySummary,
    MemoryWriteResult,
    memory_graph_from_summary,
    summary_from_memory_graph,
)

from backend.services.memory_graph_service import memory_graph_delta_from_summary

router = APIRouter(prefix="/api/memory", tags=["memory"])
MAX_MEMORY_INTERACTIONS = 50
MAX_CLIENT_MEMORY_ITEMS = 80
MAX_SESSION_HASH_CHARS = 120


class MemorySummarizePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    interactions: list[MemoryInteraction] = Field(default_factory=list, max_length=MAX_MEMORY_INTERACTIONS)
    force: bool = False
    save: bool = True
    locale: str = "auto"

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))


class MemorySavePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    summary: MemorySummary


class MemoryGraphSavePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    graph: MemoryGraph
    expected_version: int | None = Field(default=None, ge=1)
    also_update_summary: bool = False  # retained for wire compatibility; ignored


class MemoryGraphPatchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    patch: MemoryGraphPatch
    also_update_summary: bool = False


class MemoryGraphMergePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    graph: MemoryGraph | None = None
    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_CLIENT_MEMORY_ITEMS)
    also_update_summary: bool = False


@router.get("/v3", response_model=MemoryGraphLoadResult)
async def load_memory_v3(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        return _graph_load_result(graph, services)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_graph_load_failed", "Failed to load memory graph", context.request_id, exc)


@router.put("/v3", response_model=MemoryGraphWriteResult)
async def save_memory_v3(
    payload: MemoryGraphSavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphWriteResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        graph = _graph_for_session(payload.graph, user_id_hash=context.session.user_id_hash)
        result = await services.memory_repo.replace(
            user_id_hash=context.session.user_id_hash,
            graph=graph,
            expected_version=payload.expected_version if payload.expected_version is not None else graph.version,
        )
        return MemoryGraphWriteResult(
            user_id_hash=context.session.user_id_hash,
            saved=True,
            memory_updated=result.changed,
            version=result.snapshot.version,
            provider=services.db.provider.name,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_graph_save_failed", "Failed to save memory graph", context.request_id, exc)


@router.patch("/v3", response_model=MemoryGraphLoadResult)
async def patch_memory_v3(
    payload: MemoryGraphPatchPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        result = await services.memory_repo.patch(user_id_hash=context.session.user_id_hash, patch=payload.patch)
        return _graph_load_result(result.snapshot, services)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_graph_patch_failed", "Failed to patch memory graph", context.request_id, exc)


@router.delete("/v3/items/{atom_id}", response_model=MemoryGraphLoadResult)
async def delete_memory_v3_item(
    atom_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        clean_id = sanitize_text(atom_id, 160)
        if not clean_id:
            raise HTTPException(status_code=422, detail={"code": "invalid_atom_id", "message": "Invalid memory item ID"})
        result = await services.memory_repo.delete_atom(user_id_hash=context.session.user_id_hash, atom_id=clean_id)
        return _graph_load_result(result.snapshot, services)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("memory_graph_delete_item_failed", "Failed to delete memory graph item", context.request_id, exc)


@router.post("/v3/merge", response_model=MemoryGraphLoadResult)
async def merge_memory_v3(
    payload: MemoryGraphMergePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        incoming: MemoryGraph | list[MemoryAtom] = payload.graph or payload.atoms
        result = await services.memory_repo.merge(user_id_hash=context.session.user_id_hash, delta=incoming)
        return _graph_load_result(result.snapshot, services)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_graph_merge_failed", "Failed to merge memory graph", context.request_id, exc)


@router.post("/v3/migrate", response_model=MemoryGraphLoadResult)
async def migrate_memory_v3(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        graph = await services.memory_repo.load(context.session.user_id_hash)
        result = _graph_load_result(graph, services)
        return result.model_copy(update={"migrated_from_summary": True})
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_graph_migrate_failed", "Failed to migrate memory graph", context.request_id, exc)


@router.get("", response_model=MemoryLoadResult)
async def load_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryLoadResult:
    """Backward-compatible projection derived from Memory Graph V3."""
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        return MemoryLoadResult(
            user_id_hash=context.session.user_id_hash,
            loaded=True,
            source=graph.source,
            summary=summary_from_memory_graph(graph),
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_load_failed", "Failed to load memory", context.request_id, exc)


@router.post("/summarize", response_model=MemoryCompactionResult)
async def summarize_memory(
    payload: MemorySummarizePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryCompactionResult:
    assert_authenticated(context)
    operation_id = sanitize_text(f"{context.request_id}:memory-summary", 120)
    claim = None
    reserved = False
    try:
        await services.rate_limits.consume(
            scope="memory_summary",
            subject=context.session.user_id_hash,
            limit=services.settings.SAFETY_DIAGNOSTIC_RATE_LIMIT_PER_MINUTE,
            window_seconds=60,
        )
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="memory_summary",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed and claim.response:
            return MemoryCompactionResult.model_validate(claim.response)
        await services.quota.reserve(
            user_id_hash=context.session.user_id_hash,
            request_id=operation_id,
            cost=services.settings.PROVIDER_OPERATION_QUOTA_COST,
            operation="memory_summary",
        )
        reserved = True
        graph = await services.memory_repo.load(context.session.user_id_hash)
        compaction = await services.memory.compact(
            MemoryCompactionRequest(
                request_id=context.request_id,
                user_id_hash=context.session.user_id_hash,
                existing_summary=summary_from_memory_graph(graph),
                interactions=payload.interactions,
                locale=payload.locale if payload.locale != "auto" else context.locale,
                force=payload.force,
            )
        )
        final = compaction
        if payload.save and compaction.changed:
            delta = memory_graph_delta_from_summary(compaction.summary, source=MemorySource.BACKEND_COMPACTION)
            merged = await services.memory_repo.merge(user_id_hash=context.session.user_id_hash, delta=delta)
            final = compaction.model_copy(
                update={"summary": summary_from_memory_graph(merged.snapshot), "changed": merged.changed}
            )
        used_llm = bool(getattr(services.memory.last_meta, "used_llm", False))
        if used_llm:
            await services.quota.commit(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        else:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        await services.idempotency.complete(claim=claim, response=final.model_dump(mode="json"))
        return final
    except AppError as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        if reserved:
            await services.quota.refund(user_id_hash=context.session.user_id_hash, request_id=operation_id)
        if claim:
            await services.idempotency.fail(claim=claim)
        raise _internal_error("memory_summarize_failed", "Failed to summarize memory", context.request_id, exc)


@router.put("", response_model=MemoryWriteResult)
async def save_memory(
    payload: MemorySavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    """Legacy write mapped atomically into canonical Memory Graph V3."""
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        summary = _summary_for_session(payload.summary, user_id_hash=context.session.user_id_hash)
        graph = memory_graph_from_summary(summary)
        existing = await services.memory_repo.load(context.session.user_id_hash)
        result = await services.memory_repo.replace(
            user_id_hash=context.session.user_id_hash,
            graph=graph,
            expected_version=existing.version,
        )
        return MemoryWriteResult(
            user_id_hash=context.session.user_id_hash,
            saved=True,
            provider=services.db.provider.name,
            memory_updated=result.changed,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_save_failed", "Failed to save memory", context.request_id, exc)


@router.delete("", response_model=MemoryWriteResult)
async def delete_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        await services.memory_repo.delete_all(user_id_hash=context.session.user_id_hash)
        return MemoryWriteResult(
            user_id_hash=context.session.user_id_hash,
            saved=True,
            provider=services.db.provider.name,
            memory_updated=True,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_delete_failed", "Failed to delete memory", context.request_id, exc)


@router.get("/health")
async def memory_health(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    return {"status": "ok", "request_id": context.request_id}


async def _limit_write(services: Any, context: Any) -> None:
    await services.rate_limits.consume(
        scope="memory_write",
        subject=context.session.user_id_hash,
        limit=services.settings.MEMORY_WRITE_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )


def _graph_load_result(graph: MemoryGraph, services: Any) -> MemoryGraphLoadResult:
    return MemoryGraphLoadResult(
        user_id_hash=graph.user_id_hash,
        loaded=True,
        graph=graph,
        provider=services.db.provider.name,
    )


def _summary_for_session(summary: MemorySummary, *, user_id_hash: str) -> MemorySummary:
    clean_user_hash = sanitize_text(user_id_hash, MAX_SESSION_HASH_CHARS)
    if not clean_user_hash:
        raise HTTPException(status_code=401, detail={"code": "invalid_authenticated_session"})
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


def _graph_for_session(graph: MemoryGraph, *, user_id_hash: str) -> MemoryGraph:
    clean_user_hash = sanitize_text(user_id_hash, MAX_SESSION_HASH_CHARS)
    if not clean_user_hash:
        raise HTTPException(status_code=401, detail={"code": "invalid_authenticated_session"})
    return graph.model_copy(
        update={
            "user_id_hash": clean_user_hash,
            "atoms": graph.atoms[:MAX_CLIENT_MEMORY_ITEMS],
            "version": max(1, graph.version),
            "full_snapshot": True,
        }
    )


def _internal_error(code: str, message: str, request_id: str, exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": code, "message": message, "request_id": request_id},
    )
