# backend/http/sessions.py — Thin HTTP adapter for cloud chat session management

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header
from pydantic import BaseModel

from backend.domain.identity.identity import verify_auth_header, IdentityService

router = APIRouter()
identity_service = IdentityService()


class AppendMessagePayload(BaseModel):
    role: str
    content: str


@router.get("/api/chats/current", operation_id="sessionsGetCurrent")
def get_current_session(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    doc = identity_service.store.get_document("chat_sessions", session.user_id_hash)
    if not doc:
        doc = {"user_id_hash": session.user_id_hash, "messages": []}
        identity_service.store.set_document("chat_sessions", session.user_id_hash, doc)
    return doc


@router.put("/api/chats/current", operation_id="sessionsReplaceCurrent")
def replace_current_session(payload: Dict[str, Any], authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    payload["user_id_hash"] = session.user_id_hash
    identity_service.store.set_document("chat_sessions", session.user_id_hash, payload)
    return payload


@router.delete("/api/chats/current", operation_id="sessionsDeleteCurrent")
def delete_current_session(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    identity_service.store.delete_document("chat_sessions", session.user_id_hash)
    return {"status": "deleted"}


@router.post("/api/chats/current/messages", operation_id="sessionsAppendMessages")
def append_message(payload: AppendMessagePayload, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    doc = identity_service.store.get_document("chat_sessions", session.user_id_hash) or {"user_id_hash": session.user_id_hash, "messages": []}
    doc["messages"].append({"role": payload.role, "content": payload.content})
    identity_service.store.set_document("chat_sessions", session.user_id_hash, doc)
    return doc


class SessionTelemetryPayload(BaseModel):
    session_id: str
    event: str = "heartbeat"  # "start" | "heartbeat" | "inactive" | "active" | "ended"
    active_duration_seconds: float = 0.0
    inactivity_count: int = 0
    total_idle_seconds: float = 0.0
    last_idle_duration_seconds: float = 0.0
    is_online: bool = True


@router.post("/api/sessions/telemetry", operation_id="sessionsRecordTelemetry")
def record_session_telemetry(payload: SessionTelemetryPayload, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    doc_key = f"{session.user_id_hash}:{payload.session_id}"
    record = identity_service.store.get_document("session_telemetry", doc_key) or {
        "session_id": payload.session_id,
        "user_id_hash": session.user_id_hash,
        "created_at": None,
    }
    record["last_event"] = payload.event
    record["active_duration_seconds"] = payload.active_duration_seconds
    record["inactivity_count"] = payload.inactivity_count
    record["total_idle_seconds"] = payload.total_idle_seconds
    record["last_idle_duration_seconds"] = payload.last_idle_duration_seconds
    record["is_online"] = payload.is_online
    identity_service.store.set_document("session_telemetry", doc_key, record)
    return {"status": "ok", "session_id": payload.session_id}



from backend.domain.greeting.engine import GreetingEngine
from backend.domain.memory.graph import MemoryGraphService

_greeting_engine = GreetingEngine()
_memory_service = MemoryGraphService()


@router.get("/api/greeting", operation_id="greetingGet")
def get_greeting(
    tz_offset: int = 0,
    display_name: Optional[str] = None,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """
    Returns a contextual, cached greeting for the authenticated user.
    Uses timezone offset, return gap, and memory graph to score specificity.
    AI is only called when score >= 5 and memory context exists.
    Cache key: greeting_cache:{uid}:{date}:{period} — max 4 generations/day.
    """
    session = verify_auth_header(authorization)
    graph = _memory_service.get_memory_graph(session.user_id_hash)
    result = _greeting_engine.get_greeting(
        user_id_hash=session.user_id_hash,
        display_name=display_name,
        tz_offset_minutes=tz_offset,
        memory_summary=graph.summary,
        memory_atoms=[{"category": a.category, "value": a.value} for a in graph.atoms],
    )
    return result
