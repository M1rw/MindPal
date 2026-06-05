# backend/api/chat_store_router.py

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.security import sanitize_text


router = APIRouter(prefix="/api/chats", tags=["chats"])

CHAT_COLLECTION = "chat_sessions"
CURRENT_CHAT_ID = "current"
MAX_MESSAGES_PER_CHAT = 500
MAX_MESSAGE_TEXT_CHARS = 24_000
MAX_TITLE_CHARS = 120
MAX_ID_CHARS = 120
MAX_ROLE_CHARS = 30
MAX_METADATA_CHARS = 2_000


@router.get("/current")
async def get_current_chat(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    _require_authenticated(context)

    doc = await _load_chat_doc(services, context.session.user_id_hash)

    return {
        "status": "ok",
        "chat": doc,
        "source": services.db.provider.name,
        "request_id": context.request_id,
    }


@router.put("/current")
async def replace_current_chat(
    payload: dict[str, Any],
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    _require_authenticated(context)

    messages = _sanitize_messages(
        payload.get("messages") or [],
        user_id_hash=context.session.user_id_hash,
    )

    title = sanitize_text(str(payload.get("title") or "Current chat"), MAX_TITLE_CHARS) or "Current chat"

    now = _utcnow()
    existing = await _load_chat_doc(services, context.session.user_id_hash)

    doc = {
        "version": 1,
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": context.session.user_id_hash,
        "title": title,
        "messages": messages[-MAX_MESSAGES_PER_CHAT:],
        "message_count": len(messages[-MAX_MESSAGES_PER_CHAT:]),
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
    }

    await _save_chat_doc(services, context.session.user_id_hash, doc)

    return {
        "status": "ok",
        "chat": doc,
        "source": services.db.provider.name,
        "request_id": context.request_id,
    }


@router.post("/current/messages")
async def append_current_chat_messages(
    payload: dict[str, Any],
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    _require_authenticated(context)

    incoming = _sanitize_messages(
        payload.get("messages") or [],
        user_id_hash=context.session.user_id_hash,
    )

    existing = await _load_chat_doc(services, context.session.user_id_hash)
    merged = _merge_messages(existing.get("messages") or [], incoming)

    now = _utcnow()

    doc = {
        "version": 1,
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": context.session.user_id_hash,
        "title": sanitize_text(str(existing.get("title") or "Current chat"), MAX_TITLE_CHARS) or "Current chat",
        "messages": merged[-MAX_MESSAGES_PER_CHAT:],
        "message_count": len(merged[-MAX_MESSAGES_PER_CHAT:]),
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
    }

    await _save_chat_doc(services, context.session.user_id_hash, doc)

    return {
        "status": "ok",
        "chat": doc,
        "synced_count": len(incoming),
        "source": services.db.provider.name,
        "request_id": context.request_id,
    }


@router.delete("/current")
async def delete_current_chat(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    _require_authenticated(context)

    await services.db.provider.delete_document(
        CHAT_COLLECTION,
        _chat_doc_key(context.session.user_id_hash),
    )

    return {
        "status": "ok",
        "deleted": True,
        "source": services.db.provider.name,
        "request_id": context.request_id,
    }


def _require_authenticated(context: Any) -> None:
    if not bool(context.session.authenticated):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "auth_required",
                "message": "Cloud chat sync requires sign-in.",
                "details": {},
                "request_id": context.request_id,
            },
        )


async def _load_chat_doc(services: Any, user_id_hash: str) -> dict[str, Any]:
    payload = await services.db.provider.get_document(
        CHAT_COLLECTION,
        _chat_doc_key(user_id_hash),
    )

    if not isinstance(payload, dict):
        return _empty_chat_doc(user_id_hash)

    return _normalize_chat_doc(payload, user_id_hash)


async def _save_chat_doc(services: Any, user_id_hash: str, doc: dict[str, Any]) -> None:
    await services.db.provider.set_document(
        CHAT_COLLECTION,
        _chat_doc_key(user_id_hash),
        _normalize_chat_doc(doc, user_id_hash),
    )


def _empty_chat_doc(user_id_hash: str) -> dict[str, Any]:
    now = _utcnow()

    return {
        "version": 1,
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": user_id_hash,
        "title": "Current chat",
        "messages": [],
        "message_count": 0,
        "created_at": now,
        "updated_at": now,
    }


def _normalize_chat_doc(payload: dict[str, Any], user_id_hash: str) -> dict[str, Any]:
    messages = _sanitize_messages(
        payload.get("messages") or [],
        user_id_hash=user_id_hash,
    )

    created_at = sanitize_text(str(payload.get("created_at") or ""), 80) or _utcnow()
    updated_at = sanitize_text(str(payload.get("updated_at") or ""), 80) or _utcnow()

    return {
        "version": 1,
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": user_id_hash,
        "title": sanitize_text(str(payload.get("title") or "Current chat"), MAX_TITLE_CHARS) or "Current chat",
        "messages": messages[-MAX_MESSAGES_PER_CHAT:],
        "message_count": len(messages[-MAX_MESSAGES_PER_CHAT:]),
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _sanitize_messages(raw_messages: Any, *, user_id_hash: str) -> list[dict[str, Any]]:
    if not isinstance(raw_messages, list):
        return []

    clean_messages: list[dict[str, Any]] = []

    for index, raw in enumerate(raw_messages[-MAX_MESSAGES_PER_CHAT:]):
        if not isinstance(raw, dict):
            continue

        role = _normalize_role(raw.get("role"))
        text = sanitize_text(str(raw.get("text") or raw.get("content") or ""), MAX_MESSAGE_TEXT_CHARS)

        if not text:
            continue

        created_at = sanitize_text(
            str(raw.get("created_at") or raw.get("createdAt") or ""),
            80,
        ) or _utcnow()

        message_id = sanitize_text(
            str(raw.get("message_id") or raw.get("messageId") or ""),
            MAX_ID_CHARS,
        )

        if not message_id:
            message_id = _message_fingerprint(
                user_id_hash=user_id_hash,
                role=role,
                text=text,
                created_at=created_at,
                index=index,
            )

        clean_messages.append(
            {
                "message_id": message_id,
                "role": role,
                "text": text,
                "created_at": created_at,
                "provider_used": sanitize_text(str(raw.get("provider_used") or raw.get("providerUsed") or ""), 80),
                "request_id": sanitize_text(str(raw.get("request_id") or raw.get("requestId") or ""), 120),
                "mode": sanitize_text(str(raw.get("mode") or ""), 80),
                "metadata": _sanitize_metadata(raw),
            }
        )

    return _merge_messages([], clean_messages)


def _normalize_role(value: Any) -> str:
    raw = sanitize_text(str(value or ""), MAX_ROLE_CHARS).lower()

    if raw in {"user", "human"}:
        return "User"

    return "MindPal"


def _sanitize_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "safety",
        "ragUsed",
        "rag_used",
        "memoryUpdated",
        "memory_updated",
        "regenerated",
        "errorCode",
        "error_code",
        "providerUsed",
        "provider_used",
    }

    metadata: dict[str, Any] = {}

    for key, value in raw.items():
        if key not in allowed:
            continue

        clean_key = sanitize_text(str(key), 80)

        if isinstance(value, (str, int, float, bool)) or value is None:
            metadata[clean_key] = sanitize_text(str(value), MAX_METADATA_CHARS) if isinstance(value, str) else value
        elif isinstance(value, list):
            metadata[clean_key] = [
                sanitize_text(str(item), 300)
                for item in value[:20]
            ]
        elif isinstance(value, dict):
            metadata[clean_key] = {
                sanitize_text(str(k), 80): sanitize_text(str(v), 300)
                for k, v in list(value.items())[:30]
            }

    return metadata


def _merge_messages(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}

    for message in [*existing, *incoming]:
        if not isinstance(message, dict):
            continue

        message_id = sanitize_text(str(message.get("message_id") or message.get("messageId") or ""), MAX_ID_CHARS)
        if not message_id:
            continue

        normalized = {
            **message,
            "message_id": message_id,
            "role": _normalize_role(message.get("role")),
            "text": sanitize_text(str(message.get("text") or ""), MAX_MESSAGE_TEXT_CHARS),
            "created_at": sanitize_text(str(message.get("created_at") or message.get("createdAt") or ""), 80) or _utcnow(),
        }

        if normalized["text"]:
            by_id[message_id] = normalized

    merged = list(by_id.values())
    merged.sort(key=lambda item: (str(item.get("created_at") or ""), str(item.get("message_id") or "")))

    return merged[-MAX_MESSAGES_PER_CHAT:]


def _chat_doc_key(user_id_hash: str) -> str:
    clean = sanitize_text(str(user_id_hash or ""), 160)
    if not clean:
        clean = "unknown"
    return f"{clean}__{CURRENT_CHAT_ID}"


def _message_fingerprint(
    *,
    user_id_hash: str,
    role: str,
    text: str,
    created_at: str,
    index: int,
) -> str:
    seed = f"{user_id_hash}|{role}|{created_at}|{index}|{text}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"msg_{digest}"


def _utcnow() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
