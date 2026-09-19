# backend/http/memory.py — Thin HTTP adapter for durable memory graph

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field, field_validator

from backend.core.errors import AppError
from backend.domain.identity.identity import UserSession, account_guard, verify_auth_header
from backend.domain.memory.extract import can_persist_user_memory
from backend.domain.memory.graph import (
    MAX_ATOMS,
    MAX_SUMMARY_CHARS,
    MemoryGraph,
    MemoryGraphService,
    atom_from_mapping,
    clip_atom_value,
    honest_summary,
    summary_from_atoms,
)

router = APIRouter()
memory_service = MemoryGraphService()

# A PUT replaces the whole graph, so it needs the same ceiling the merge path
# applies. Without it a client could park an unbounded blob in the document that
# every chat turn then loads.
MAX_ATOMS_PER_PUT = MAX_ATOMS
MAX_RAW_ATOMS_ACCEPTED = 200


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
    existing = memory_service.get_memory_graph(session.user_id_hash)
    if payload.atoms is None:
        atoms = existing.atoms
    else:
        # Clip values and cap the count exactly as merge_atoms does. The two
        # write paths landing in the same document disagreed before this.
        seen: set[str] = set()
        atoms = []
        for raw in payload.atoms:
            atom = atom_from_mapping(raw)
            if atom is None or atom.id in seen:
                continue
            atom.value = clip_atom_value(atom.value)
            if not atom.value:
                continue
            seen.add(atom.id)
            atoms.append(atom)
            if len(atoms) >= MAX_ATOMS_PER_PUT:
                break
    summary = existing.summary if payload.summary is None else honest_summary(payload.summary)
    if not summary and atoms:
        summary = summary_from_atoms(atoms)
    graph = MemoryGraph(
        user_id_hash=session.user_id_hash,
        summary=summary,
        atoms=atoms,
    )
    memory_service.save_memory_graph(graph)
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
    graph = memory_service.update_atom(session.user_id_hash, atom_id, value)
    if graph is None:
        raise AppError("not_found", "That memory item is not saved.")
    return _graph_payload(graph, include_user_key=True)


@router.delete("/api/memory/graph/items/{atom_id}", operation_id="memoryDeleteGraphItem")
def delete_memory_item(
    atom_id: str, session: UserSession = Depends(_persistable_session)
) -> Dict[str, Any]:
    graph = memory_service.get_memory_graph(session.user_id_hash)
    graph.atoms = [a for a in graph.atoms if a.id != atom_id]
    memory_service.save_memory_graph(graph)
    return _graph_payload(graph, include_user_key=True)


@router.get("/api/memory/summary", operation_id="memoryGetSummary")
def get_memory_summary(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    if not session.has_account_storage or not can_persist_user_memory(session.user_id_hash):
        return {"summary": ""}
    graph = memory_service.get_memory_graph(session.user_id_hash)
    summary = graph.summary
    if not summary and graph.atoms:
        graph = memory_service.rebuild_summary(session.user_id_hash)
        summary = graph.summary
    return {"user_id_hash": session.user_id_hash, "summary": summary}


@router.post("/api/memory/summary/refresh", operation_id="memoryRefreshSummary")
def refresh_memory_summary(
    payload: Optional[SummaryUpdatePayload] = None,
    session: UserSession = Depends(_persistable_session),
) -> Dict[str, Any]:
    """Recompute the stored summary from saved atoms, or store a supplied one.

    With no body this rebuilds the summary from what is actually saved. It does
    not call a model: the endpoint never did, and claiming otherwise in the name
    was the whole of the confusion.
    """
    supplied = payload.summary if payload else None
    if supplied is not None:
        graph = memory_service.update_summary(session.user_id_hash, supplied)
    else:
        graph = memory_service.rebuild_summary(session.user_id_hash)
    return {"user_id_hash": session.user_id_hash, "summary": graph.summary}
