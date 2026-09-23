# backend/http/memory.py — Thin HTTP adapter for durable memory graph

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field, field_validator

from backend.core.errors import AppError
from backend.configs.runtime import api_limits_config
from backend.domain.identity.identity import UserSession, account_guard, verify_auth_header
from backend.domain.memory.consolidation import MemoryConsolidationService
from backend.domain.memory.editing import MemoryEditor, summary_payload
from backend.domain.memory.extract import can_persist_user_memory
from backend.domain.memory.graph import MAX_SUMMARY_CHARS, MemoryGraph, MemoryGraphService

router = APIRouter()
memory_service = MemoryGraphService()
consolidation = MemoryConsolidationService(memory_service.store, memory=memory_service)


def _editor() -> MemoryEditor:
    # Built per request from the module's current services, so replacing
    # `memory_service` (tests, a different store) is honoured.
    if consolidation.memory is not memory_service:
        return MemoryEditor(memory_service, MemoryConsolidationService(memory_service.store, memory=memory_service))
    return MemoryEditor(memory_service, consolidation)

MAX_RAW_ATOMS_ACCEPTED = int(api_limits_config()["memory"]["max_raw_atoms_accepted"])


def _persistable_session(
    session: UserSession = Depends(account_guard("save memory with your account")),
) -> UserSession:
    """Account gate plus the memory domain's own persistability rule.

    Declared as a dependency so the credential is checked before the body is
    parsed: an unauthenticated PUT with a bad payload should be told to sign in,
    not handed a description of the schema.
    """
    if not can_persist_user_memory(session.user_id_hash):
        raise AppError("unauthenticated", "Sign in to save memory with your account.")
    return session


def _graph_payload(graph: MemoryGraph, *, include_user_key: bool) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "summary": graph.summary,
        "atoms": [
            {"id": a.id, "category": a.category, "value": a.value, "confidence": a.confidence}
            for a in graph.atoms
        ],
    }
    if include_user_key:
        payload["user_id_hash"] = graph.user_id_hash
    return payload


class MemoryGraphPutPayload(BaseModel):
    summary: Optional[str] = Field(default=None, max_length=MAX_SUMMARY_CHARS * 4)
    atoms: Optional[List[Dict[str, Any]]] = None

    @field_validator("atoms")
    @classmethod
    def _bounded_atoms(cls, value: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
        if value is None:
            return None
        if len(value) > MAX_RAW_ATOMS_ACCEPTED:
            raise ValueError(f"atoms supports at most {MAX_RAW_ATOMS_ACCEPTED} entries per request")
        return value


class SummaryUpdatePayload(BaseModel):
    """Body for POST /api/memory/summary/refresh.

    `summary` is optional: the web client posts no body and expects the stored
    summary back, which used to be a 422. An explicit string still overwrites.
    """

    summary: Optional[str] = Field(default=None, max_length=MAX_SUMMARY_CHARS * 4)


class MemoryAtomPatchPayload(BaseModel):
    value: str = Field(max_length=2_000)


@router.get("/api/memory/graph", operation_id="memoryGetGraph")
def get_memory_graph(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.has_account_storage or not can_persist_user_memory(session.user_id_hash):
        # Guests keep memory on their own device. Answer honestly rather than
        # handing back a shared bucket.
        return _graph_payload(MemoryGraph(user_id_hash=""), include_user_key=False)
    graph = memory_service.get_memory_graph(session.user_id_hash)
    return _graph_payload(graph, include_user_key=True)


@router.put("/api/memory/graph", operation_id="memoryPutGraph")
def put_memory_graph(
    payload: MemoryGraphPutPayload, session: UserSession = Depends(_persistable_session)
) -> Dict[str, Any]:
    graph = _editor().replace(session.user_id_hash, payload.atoms, payload.summary)
    return _graph_payload(graph, include_user_key=True)


@router.patch("/api/memory/graph/items/{atom_id}", operation_id="memoryPatchGraphItem")
def patch_memory_item(
    atom_id: str,
    payload: MemoryAtomPatchPayload,
    session: UserSession = Depends(_persistable_session),
) -> Dict[str, Any]:
    value = " ".join((payload.value or "").split())
    if not value:
        raise AppError("payload_invalid", "Memory text cannot be empty.")
    # Through the editor, so the corrected fact's old wording is forgotten too.
    graph = _editor().edit_atom(session.user_id_hash, atom_id, value)
    if graph is None:
        raise AppError("not_found", "That memory item is not saved.")
    return _graph_payload(graph, include_user_key=True)


@router.delete("/api/memory/graph/items/{atom_id}", operation_id="memoryDeleteGraphItem")
def delete_memory_item(
    atom_id: str, session: UserSession = Depends(_persistable_session)
) -> Dict[str, Any]:
    return _graph_payload(_editor().delete_atom(session.user_id_hash, atom_id), include_user_key=True)


@router.get("/api/memory/summary", operation_id="memoryGetSummary")
def get_memory_summary(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.has_account_storage or not can_persist_user_memory(session.user_id_hash):
        return {"summary": ""}
    return _editor().summary_view(session.user_id_hash)


@router.post("/api/memory/summary/refresh", operation_id="memoryRefreshSummary")
def refresh_memory_summary(
    payload: Optional[SummaryUpdatePayload] = None,
    session: UserSession = Depends(_persistable_session),
) -> Dict[str, Any]:
    """Store a summary the person wrote, or ask MindPal to rewrite its AI summary now.

    With no body: the AI summary is rebuilt from conversation digests and saved
    facts if the person's daily budget and the platform load allow; otherwise
    the request is queued for the scheduler. `status` says which happened.
    """
    supplied = payload.summary if payload else None
    if supplied is not None:
        graph = memory_service.update_summary(session.user_id_hash, supplied)
        return {**summary_payload(session.user_id_hash, graph), "status": "saved"}
    return _editor().refresh_summary(session.user_id_hash)


@router.get("/api/memory/journal", operation_id="memoryGetJournal")
def get_memory_journal(session: UserSession = Depends(_persistable_session)) -> Dict[str, Any]:
    """The AI summary, the conversation digests behind it, and what is queued. Transparency."""
    return consolidation.describe(session.user_id_hash)


@router.delete("/api/memory/narrative", operation_id="memoryForgetNarrative")
def forget_memory_narrative(session: UserSession = Depends(_persistable_session)) -> Dict[str, Any]:
    """Delete the AI summary, its digests, and any journaled turns. Saved facts stay."""
    consolidation.forget(session.user_id_hash)
    return {"forgotten": True}
