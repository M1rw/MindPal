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
