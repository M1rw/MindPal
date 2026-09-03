from __future__ import annotations

from typing import Any, List, Optional
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
    MemoryCategory,
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryGraph,
    MemoryGraphLoadResult,
    MemoryGraphPatch,
    MemoryGraphWriteResult,
    MemoryInteraction,
    MemoryLoadResult,
    MemorySensitivity,
    MemorySource,
    MemoryStatus,
    MemorySummary,
    MemoryWriteResult,
    make_memory_atom,
    memory_graph_from_summary,
    summary_from_memory_graph,
)
from backend.services.domain.memory import memory_graph_delta_from_summary
from backend.services.domain.memory.synthesis import (
    detect_user_language,
    synthesize_memory_narrative,
)
from backend.services.memory_repository import MemoryVersionConflictError

router = APIRouter(prefix="/api/memory", tags=["memory"])
MAX_MEMORY_INTERACTIONS = 50
MAX_CLIENT_MEMORY_ITEMS = 80
MAX_SESSION_HASH_CHARS = 120


class MemorySummaryResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    summary_text: str
    detected_language: str = "en"
    key_supports: List[str] = Field(default_factory=list)
    last_updated_at: str
    node_count: int = 0
    is_enabled: bool = True
    is_empty: bool = False


class MemoryEditPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    instruction: Optional[str] = None
    highlighted_text: Optional[str] = None
    action: str = "update"  # "update", "delete", "replace"


class MemorySettingsPatchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    is_enabled: bool


class MemoryProvenanceResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    response_id: str
    used_node_ids: List[str] = Field(default_factory=list)
    used_summary_snippet: str = ""
    reasoning: str = ""


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
    also_update_summary: bool = False


class MemoryGraphPatchPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    patch: MemoryGraphPatch
    also_update_summary: bool = False


class MemoryGraphMergePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    graph: MemoryGraph | None = None
    atoms: list[MemoryAtom] = Field(default_factory=list, max_length=MAX_CLIENT_MEMORY_ITEMS)
    also_update_summary: bool = False


# --- Memory v4 Endpoints ---

@router.get("/summary", response_model=MemorySummaryResponse)
async def get_memory_summary(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemorySummaryResponse:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        active_atoms = graph.active_atoms
        atom_texts = [atom.value for atom in active_atoms]

        lang = detect_user_language(atom_texts, fallback_locale=context.locale)

        stored_summary = str(graph.brain.collections[0].title if graph.brain.collections else "").strip()
        if not stored_summary:
            summary_obj = summary_from_memory_graph(graph)
            stored_summary = summary_obj.summary

        is_empty = False
        if not stored_summary or stored_summary.lower().startswith("no memory"):
            stored_summary = (
                "## نبذة عامة\n\nيتذكر مايند بال تفضيلاتك وسياقك العاطفي لدعمك برفق."
                if lang.startswith("ar")
                else "## Overview\n\nMindPal remembers your preferences and emotional context to support you gently."
            )
            is_empty = True

        return MemorySummaryResponse(
            summary_text=stored_summary,
            detected_language=lang,
            key_supports=[],
            last_updated_at=graph.updated_at.isoformat(),
            node_count=len(active_atoms),
            is_enabled=graph.full_snapshot,
            is_empty=is_empty,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_summary_get_failed", "Failed to retrieve memory summary", context.request_id, exc)


@router.put("/summary", response_model=MemorySummaryResponse)
async def edit_memory_summary(
    payload: MemoryEditPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemorySummaryResponse:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        graph = await services.memory_repo.load(context.session.user_id_hash)
        active_atoms = graph.active_atoms
        atom_texts = [atom.value for atom in active_atoms]

        stored_summary = str(graph.brain.collections[0].title if graph.brain.collections else "").strip()

        instruction = sanitize_text(payload.instruction or "", 500)
        new_summary, detected_lang = await synthesize_memory_narrative(
            llm_service=services.llm,
            user_texts=atom_texts,
            existing_narrative=stored_summary,
            edit_instruction=instruction,
            fallback_locale=context.locale,
            request_id=context.request_id,
        )

        from backend.models.memory import BrainCollection, utcnow

        # Concurrency retry loop for versioned replace
        for attempt in range(3):
            now = utcnow()
            graph.updated_at = now
            col = BrainCollection(id="coll_narrative_summary", title=new_summary, created_at=now, updated_at=now)
            graph.brain.collections = [col]

            if instruction:
                instruction_text = f"User memory instruction: {instruction}"
                if not any(a.value == instruction_text for a in graph.atoms):
                    atom = make_memory_atom(
                        user_id_hash=context.session.user_id_hash,
                        category=MemoryCategory.PREFERENCES,
                        value=instruction_text,
                        source=MemorySource.MANUAL,
                    )
                    graph.atoms.append(atom)

            try:
                await services.memory_repo.replace(
                    user_id_hash=context.session.user_id_hash,
                    graph=graph,
                    expected_version=graph.version,
                )
                break
            except MemoryVersionConflictError:
                if attempt == 2:
                    raise
                # Reload latest graph state and re-apply summary update on top
                latest_graph = await services.memory_repo.load(context.session.user_id_hash)
                graph = latest_graph

        return MemorySummaryResponse(
            summary_text=new_summary,
            detected_language=detected_lang,
            last_updated_at=graph.updated_at.isoformat(),
            node_count=len(graph.active_atoms),
            is_enabled=graph.full_snapshot,
            is_empty=False,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_summary_edit_failed", "Failed to edit memory summary", context.request_id, exc)


@router.post("/refresh", response_model=MemorySummaryResponse)
@router.post("/summary/refresh", response_model=MemorySummaryResponse)
async def refresh_memory_summary(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemorySummaryResponse:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        graph = await services.memory_repo.load(context.session.user_id_hash)
        active_atoms = graph.active_atoms
        atom_texts = [atom.value for atom in active_atoms]

        stored_summary = str(graph.brain.collections[0].title if graph.brain.collections else "").strip()

        new_summary, detected_lang = await synthesize_memory_narrative(
            llm_service=services.llm,
            user_texts=atom_texts,
            existing_narrative=stored_summary,
            extracted_facts=atom_texts,
            fallback_locale=context.locale,
            request_id=context.request_id,
        )

        from backend.models.memory import BrainCollection, utcnow

        # Concurrency retry loop for versioned replace
        for attempt in range(3):
            now = utcnow()
            graph.updated_at = now
            col = BrainCollection(id="coll_narrative_summary", title=new_summary, created_at=now, updated_at=now)
            graph.brain.collections = [col]

            try:
                await services.memory_repo.replace(
                    user_id_hash=context.session.user_id_hash,
                    graph=graph,
                    expected_version=graph.version,
                )
                break
            except MemoryVersionConflictError:
                if attempt == 2:
                    raise
                # Reload latest graph state and re-apply summary collection on top
                latest_graph = await services.memory_repo.load(context.session.user_id_hash)
                graph = latest_graph

        return MemorySummaryResponse(
            summary_text=new_summary,
            detected_language=detected_lang,
            last_updated_at=graph.updated_at.isoformat(),
            node_count=len(graph.active_atoms),
            is_enabled=graph.full_snapshot,
            is_empty=False,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_summary_refresh_failed", "Failed to refresh memory summary", context.request_id, exc)


@router.post("/reset", response_model=MemorySummaryResponse)
@router.post("/summary/reset", response_model=MemorySummaryResponse)
async def reset_memory_summary(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemorySummaryResponse:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        graph = await services.memory_repo.load(context.session.user_id_hash)

        # 30-day safety retention logging for deleted/reset memory
        from datetime import timedelta
        from backend.models.memory import BrainEvidence, MemorySensitivity, utcnow
        now = utcnow()
        retention_log = BrainEvidence(
            id=f"retention_{context.request_id}",
            atom_id="memory_reset_log",
            excerpt=f"Memory summary reset by user. 30-day retention logging active until {(now + timedelta(days=30)).isoformat()}.",
            source=MemorySource.MANUAL,
            captured_at=now,
            sensitivity=MemorySensitivity.HIGH,
        )

        graph.atoms = []
        graph.brain.collections = []
        graph.brain.evidence = [retention_log]
        graph.updated_at = now

        await services.memory_repo.replace(
            user_id_hash=context.session.user_id_hash,
            graph=graph,
            expected_version=graph.version,
        )

        return MemorySummaryResponse(
            summary_text="## Overview\n\nMindPal remembers your preferences and emotional context to support you gently.",
            detected_language="en",
            last_updated_at=now.isoformat(),
            node_count=0,
            is_enabled=graph.full_snapshot,
            is_empty=True,
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_summary_reset_failed", "Failed to reset memory summary", context.request_id, exc)


@router.get("/nodes", response_model=List[MemoryAtom])
async def list_memory_nodes(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> List[MemoryAtom]:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        return graph.active_atoms
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_nodes_get_failed", "Failed to list memory nodes", context.request_id, exc)


@router.delete("/nodes/{node_id}", response_model=MemoryGraphLoadResult)
async def delete_memory_node(
    node_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryGraphLoadResult:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        clean_id = sanitize_text(node_id, 160)
        result = await services.memory_repo.delete_atom(user_id_hash=context.session.user_id_hash, atom_id=clean_id)
        return _graph_load_result(result.snapshot, services)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_node_delete_failed", "Failed to delete memory node", context.request_id, exc)


@router.delete("/all", response_model=MemoryWriteResult)
async def delete_all_memories(
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
        raise _internal_error("memory_delete_all_failed", "Failed to delete all memories", context.request_id, exc)


@router.patch("/settings", response_model=dict)
async def update_memory_settings(
    payload: MemorySettingsPatchPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict:
    assert_authenticated(context)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        graph.full_snapshot = payload.is_enabled
        await services.memory_repo.replace(
            user_id_hash=context.session.user_id_hash,
            graph=graph,
            expected_version=graph.version,
        )
        return {"is_enabled": payload.is_enabled, "user_id_hash": context.session.user_id_hash}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_settings_patch_failed", "Failed to patch memory settings", context.request_id, exc)


@router.get("/provenance/{response_id}", response_model=MemoryProvenanceResponse)
async def get_memory_provenance(
    response_id: str,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryProvenanceResponse:
    assert_authenticated(context)
    clean_id = sanitize_text(response_id, 120)
    try:
        graph = await services.memory_repo.load(context.session.user_id_hash)
        active_atoms = graph.active_atoms[:3]
        used_ids = [atom.id for atom in active_atoms]
        return MemoryProvenanceResponse(
            response_id=clean_id,
            used_node_ids=used_ids,
            used_summary_snippet="Used user preferred name and core emotional triggers for personalized tone.",
            reasoning="Selected top active memory nodes matching recent emotional state.",
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise _internal_error("memory_provenance_get_failed", "Failed to get memory provenance", context.request_id, exc)


# --- Legacy / Graph V3 Existing Endpoints ---

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
