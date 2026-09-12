# backend/http/memory.py — Thin HTTP adapter for durable memory graph

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header
from pydantic import BaseModel

from backend.domain.identity.identity import verify_auth_header
from backend.domain.memory.graph import MemoryGraphService, MemoryGraph, MemoryAtom

router = APIRouter()
memory_service = MemoryGraphService()


class MemoryGraphPutPayload(BaseModel):
    summary: Optional[str] = None
    atoms: Optional[list[Dict[str, Any]]] = None


class SummaryUpdatePayload(BaseModel):
    summary: str


@router.get("/api/memory/graph", operation_id="memoryGetGraph")
def get_memory_graph(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    graph = memory_service.get_memory_graph(session.user_id_hash)
    return {
        "user_id_hash": graph.user_id_hash,
        "summary": graph.summary,
        "atoms": [{"id": a.id, "category": a.category, "value": a.value, "confidence": a.confidence} for a in graph.atoms],
    }


@router.put("/api/memory/graph", operation_id="memoryPutGraph")
def put_memory_graph(payload: MemoryGraphPutPayload, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    atoms = [MemoryAtom(**a) for a in payload.atoms] if payload.atoms else []
    graph = MemoryGraph(
        user_id_hash=session.user_id_hash,
        summary=payload.summary or "User reflective context.",
        atoms=atoms,
    )
    memory_service.save_memory_graph(graph)
    return get_memory_graph(authorization)


@router.delete("/api/memory/graph/items/{atom_id}", operation_id="memoryDeleteGraphItem")
def delete_memory_item(atom_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    graph = memory_service.get_memory_graph(session.user_id_hash)
    graph.atoms = [a for a in graph.atoms if a.id != atom_id]
    memory_service.save_memory_graph(graph)
    return get_memory_graph(authorization)


@router.get("/api/memory/summary", operation_id="memoryGetSummary")
def get_memory_summary(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    graph = memory_service.get_memory_graph(session.user_id_hash)
    return {"user_id_hash": session.user_id_hash, "summary": graph.summary}


@router.post("/api/memory/summary/refresh", operation_id="memoryRefreshSummary")
def refresh_memory_summary(payload: SummaryUpdatePayload, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    graph = memory_service.update_summary(session.user_id_hash, payload.summary)
    return {"user_id_hash": session.user_id_hash, "summary": graph.summary}
