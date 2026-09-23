# backend/http/sessions.py — Thin HTTP adapter for cloud chat session management

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from backend.core.errors import AppError
from backend.domain.dynamic.policy import current_load
from backend.domain.greeting.engine import GreetingEngine
from backend.domain.identity.identity import IdentityService, UserSession, account_guard
from backend.domain.memory.graph import MemoryGraphService
from backend.domain.sessions.contracts import (
    enforce_session_cap,
    AppendMessagePayload,
    ChatSessionPayload,
    CurrentSessionPayload,
    SessionTelemetryPayload,
    MAX_MESSAGES_PER_SESSION,
    validated_session_id,
)

router = APIRouter()
identity_service = IdentityService()
_greeting_engine = GreetingEngine()
_memory_service = MemoryGraphService()


# --- Current single-session endpoints ----------------------------------------
#
# Declared BEFORE /api/chats/{session_id}. FastAPI matches routes in registration
# order, so with the parameterized route first, "current" was swallowed as a
# session id and GET/DELETE /api/chats/current never reached these handlers.

@router.get("/api/chats/current", operation_id="sessionsGetCurrent")
def get_current_session(session: UserSession = Depends(account_guard("sync chats with your account"))) -> Dict[str, Any]:
    doc = identity_service.store.get_document("chat_sessions", session.user_id_hash)
    if not doc:
        # A read must not create a record. The old version wrote an empty
        # document on every GET, so an unused account still accumulated rows.
        return {"user_id_hash": session.user_id_hash, "messages": []}
    return doc


@router.put("/api/chats/current", operation_id="sessionsReplaceCurrent")
def replace_current_session(
    payload: CurrentSessionPayload, session: UserSession = Depends(account_guard("sync chats with your account"))
) -> Dict[str, Any]:
    doc = {
        "user_id_hash": session.user_id_hash,
        "title": payload.title,
        "messages": payload.messages,
    }
    identity_service.store.set_document("chat_sessions", session.user_id_hash, doc)
    return doc


@router.delete("/api/chats/current", operation_id="sessionsDeleteCurrent")
def delete_current_session(session: UserSession = Depends(account_guard("sync chats with your account"))) -> Dict[str, Any]:
    identity_service.store.delete_document("chat_sessions", session.user_id_hash)
    return {"status": "deleted"}


@router.post("/api/chats/current/messages", operation_id="sessionsAppendMessages")
def append_message(
    payload: AppendMessagePayload, session: UserSession = Depends(account_guard("sync chats with your account"))
) -> Dict[str, Any]:
    # Appended inside a transaction: two appends at once each kept only their
    # own message when this was read-then-write (audit MP-10).
    def append(current: Any, write: Any) -> Dict[str, Any]:
        doc = dict(current or {"user_id_hash": session.user_id_hash, "messages": []})
        messages = doc.get("messages")
        messages = list(messages) if isinstance(messages, list) else []
        messages.append({"role": payload.role, "content": payload.content})
        doc["messages"] = messages[-MAX_MESSAGES_PER_SESSION:]
        doc["user_id_hash"] = session.user_id_hash
        write(doc)
        return doc

    return identity_service.store.transact("chat_sessions", session.user_id_hash, append)


# --- Multi-session cloud REST endpoints ---------------------------------------

@router.get("/api/chats", operation_id="chatsList")
def list_chat_sessions(
    limit: int = Query(default=200, ge=1, le=500),
    session: UserSession = Depends(account_guard("load chats saved to your account")),
) -> Dict[str, Any]:
    docs = identity_service.store.list_documents("chat_sessions", prefix=f"{session.user_id_hash}:")
    sorted_docs = sorted(
        docs,
        key=lambda d: str(d.get("updatedAt") or d.get("createdAt") or ""),
        reverse=True,
    )
    return {"sessions": sorted_docs[:limit]}


@router.post("/api/chats", operation_id="chatsSave")
def save_chat_session(
    payload: ChatSessionPayload,
    session: UserSession = Depends(account_guard("save chats to your account")),
) -> Dict[str, Any]:
    session_id = validated_session_id(payload.id)
    enforce_session_cap(identity_service.store, session.user_id_hash, session_id)
    doc_data = {
        "id": session_id,
        "title": payload.title,
        "createdAt": payload.createdAt,
        "updatedAt": payload.updatedAt or payload.createdAt,
        "messages": payload.messages,
        "user_id_hash": session.user_id_hash,
    }
    identity_service.store.set_document(
        "chat_sessions", f"{session.user_id_hash}:{session_id}", doc_data
    )
    return doc_data


@router.get("/api/chats/{session_id}", operation_id="chatsGet")
def get_chat_session(
    session_id: str,
    session: UserSession = Depends(account_guard("load chats saved to your account")),
) -> Dict[str, Any]:
    doc = identity_service.store.get_document(
        "chat_sessions", f"{session.user_id_hash}:{validated_session_id(session_id)}"
    )
    if not doc:
        raise AppError("not_found", "That chat is not saved to your account.")
    return doc


@router.delete("/api/chats/{session_id}", operation_id="chatsDelete")
def delete_chat_session(
    session_id: str,
    session: UserSession = Depends(account_guard("delete chats from your account")),
) -> Dict[str, Any]:
    clean_id = validated_session_id(session_id)
    deleted = identity_service.store.delete_document(
        "chat_sessions", f"{session.user_id_hash}:{clean_id}"
    )
    return {"status": "deleted" if deleted else "not_found", "session_id": clean_id}


# --- Telemetry and greeting ---------------------------------------------------

@router.post("/api/sessions/telemetry", operation_id="sessionsRecordTelemetry")
def record_session_telemetry(
    payload: SessionTelemetryPayload,
    session: UserSession = Depends(account_guard("record session activity on your account")),
) -> Dict[str, Any]:
    session_id = validated_session_id(payload.session_id)
    doc_key = f"{session.user_id_hash}:{session_id}"
    record = identity_service.store.get_document("session_telemetry", doc_key) or {
        "session_id": session_id,
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
    return {"status": "ok", "session_id": session_id}


@router.get("/api/greeting", operation_id="greetingGet")
def get_greeting(
    tz_offset: int = Query(default=0, ge=-840, le=840),
    display_name: Optional[str] = Query(default=None, max_length=80),
    session: UserSession = Depends(account_guard("load a greeting built from your memory")),
) -> Dict[str, Any]:
    graph = _memory_service.get_memory_graph(session.user_id_hash)
    return _greeting_engine.get_greeting(
        user_id_hash=session.user_id_hash,
        display_name=display_name,
        tz_offset_minutes=tz_offset,
        memory_summary=graph.summary,
        memory_atoms=[{"category": a.category, "value": a.value} for a in graph.atoms],
        open_threads=graph.open_threads,
        system_load_ok=current_load().level in {"calm", "busy"},
    )
