from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.api.dependencies import AuthenticatedRequestContextDep, ServicesDep, assert_authenticated, http_error_from_app_error
from backend.core.errors import AppError
from backend.core.security import sanitize_text

router = APIRouter(prefix="/api/chats", tags=["chats"])

CHAT_COLLECTION = "chat_sessions"
CURRENT_CHAT_ID = "current"
MAX_MESSAGES_PER_CHAT = 500
MAX_MESSAGE_TEXT_CHARS = 24_000
MAX_VOICE_TRANSCRIPT_CHARS = 8_000
MAX_VOICE_SUMMARY_CHARS = 1_500
MAX_TITLE_CHARS = 120
MAX_ID_CHARS = 120
MAX_ROLE_CHARS = 30
MAX_METADATA_CHARS = 2_000
MAX_CHAT_DOCUMENT_BYTES = 600_000


class ChatVersionConflictError(AppError):
    status_code = 409
    code = "chat_version_conflict"


class ChatReplacePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = Field(default="Current chat", max_length=MAX_TITLE_CHARS)
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_MESSAGES_PER_CHAT)
    expected_version: int | None = Field(default=None, ge=0)


class ChatAppendPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_MESSAGES_PER_CHAT)


@router.get("/current")
async def get_current_chat(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    doc = await _load_chat_doc(services, context.session.user_id_hash)
    return _response(doc, services, context)


@router.put("/current")
async def replace_current_chat(
    payload: ChatReplacePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="chat_store_replace",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed and claim.response:
            return claim.response

        messages = _sanitize_messages(payload.messages, user_id_hash=context.session.user_id_hash)
        title = sanitize_text(payload.title, MAX_TITLE_CHARS) or "Current chat"
        now = _utcnow()

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            existing = _normalize_chat_doc(data, context.session.user_id_hash) if data else _empty_chat_doc(context.session.user_id_hash)
            current_version = int(data.get("version") or 0) if data else 0
            if payload.expected_version is not None and payload.expected_version != current_version:
                raise ChatVersionConflictError(
                    "Chat changed on another device",
                    details={"expected_version": payload.expected_version, "current_version": current_version},
                )
            bounded = _bound_messages(messages)
            return {
                "version": current_version + 1,
                "chat_id": CURRENT_CHAT_ID,
                "user_id_hash": context.session.user_id_hash,
                "title": title,
                "messages": bounded,
                "message_count": len(bounded),
                "created_at": existing.get("created_at") or now,
                "updated_at": now,
            }

        doc = await services.db.provider.atomic_update_document(
            CHAT_COLLECTION,
            _chat_doc_key(context.session.user_id_hash),
            updater,
        )
        result = _response(_normalize_chat_doc(doc, context.session.user_id_hash), services, context)
        await services.idempotency.complete(claim=claim, response=result)
        return result
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "chat_store_replace_failed", "message": "Failed to save chat", "request_id": context.request_id},
        ) from exc


@router.post("/current/messages")
async def append_current_chat_messages(
    payload: ChatAppendPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="chat_store_append",
            payload_hash=services.idempotency.payload_hash(payload.model_dump(mode="json")),
        )
        if claim.completed and claim.response:
            return claim.response

        incoming = _sanitize_messages(payload.messages, user_id_hash=context.session.user_id_hash)
        now = _utcnow()

        def updater(data: dict[str, Any]) -> dict[str, Any]:
            existing = _normalize_chat_doc(data, context.session.user_id_hash) if data else _empty_chat_doc(context.session.user_id_hash)
            merged = _merge_messages(existing.get("messages") or [], incoming)
            return {
                "version": int(data.get("version") or 0) + 1,
                "chat_id": CURRENT_CHAT_ID,
                "user_id_hash": context.session.user_id_hash,
                "title": sanitize_text(str(existing.get("title") or "Current chat"), MAX_TITLE_CHARS) or "Current chat",
                "messages": merged,
                "message_count": len(merged),
                "created_at": existing.get("created_at") or now,
                "updated_at": now,
            }

        doc = await services.db.provider.atomic_update_document(
            CHAT_COLLECTION,
            _chat_doc_key(context.session.user_id_hash),
            updater,
        )
        result = {
            **_response(_normalize_chat_doc(doc, context.session.user_id_hash), services, context),
            "synced_count": len(incoming),
        }
        await services.idempotency.complete(claim=claim, response=result)
        return result
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "chat_store_append_failed", "message": "Failed to sync chat", "request_id": context.request_id},
        ) from exc


@router.delete("/current")
async def delete_current_chat(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        await _limit_write(services, context)
        claim = await services.idempotency.claim(
            user_id_hash=context.session.user_id_hash,
            key=context.request_id,
            operation="chat_store_delete",
            payload_hash=services.idempotency.payload_hash({"chat_id": CURRENT_CHAT_ID}),
        )
        if claim.completed and claim.response:
            return claim.response
        await services.db.provider.delete_document(CHAT_COLLECTION, _chat_doc_key(context.session.user_id_hash))
        result = {
            "status": "ok",
            "deleted": True,
            "source": services.db.provider.name,
            "request_id": context.request_id,
        }
        await services.idempotency.complete(claim=claim, response=result)
        return result
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "chat_store_delete_failed", "message": "Failed to delete chat", "request_id": context.request_id},
        ) from exc


async def _limit_write(services: Any, context: Any) -> None:
    await services.rate_limits.consume(
        scope="chat_sync_write",
        subject=context.session.user_id_hash,
        limit=services.settings.CHAT_SYNC_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )


async def _load_chat_doc(services: Any, user_id_hash: str) -> dict[str, Any]:
    payload = await services.db.provider.get_document(CHAT_COLLECTION, _chat_doc_key(user_id_hash))
    if not isinstance(payload, dict):
        return _empty_chat_doc(user_id_hash)
    return _normalize_chat_doc(payload, user_id_hash)


def _response(doc: dict[str, Any], services: Any, context: Any) -> dict[str, Any]:
    return {
        "status": "ok",
        "chat": doc,
        "source": services.db.provider.name,
        "request_id": context.request_id,
    }


def _empty_chat_doc(user_id_hash: str) -> dict[str, Any]:
    now = _utcnow()
    return {
        "version": 0,
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": user_id_hash,
        "title": "Current chat",
        "messages": [],
        "message_count": 0,
        "created_at": now,
        "updated_at": now,
    }


def _normalize_chat_doc(payload: dict[str, Any], user_id_hash: str) -> dict[str, Any]:
    messages = _sanitize_messages(payload.get("messages") or [], user_id_hash=user_id_hash)
    bounded = _bound_messages(messages)
    return {
        "version": max(0, int(payload.get("version") or 0)),
        "chat_id": CURRENT_CHAT_ID,
        "user_id_hash": user_id_hash,
        "title": sanitize_text(str(payload.get("title") or "Current chat"), MAX_TITLE_CHARS) or "Current chat",
        "messages": bounded,
        "message_count": len(bounded),
        "created_at": sanitize_text(str(payload.get("created_at") or ""), 80) or _utcnow(),
        "updated_at": sanitize_text(str(payload.get("updated_at") or ""), 80) or _utcnow(),
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
        created_at = sanitize_text(str(raw.get("created_at") or raw.get("createdAt") or ""), 80) or _utcnow()
        message_id = sanitize_text(str(raw.get("message_id") or raw.get("messageId") or ""), MAX_ID_CHARS)
        if not message_id:
            message_id = _message_fingerprint(
                user_id_hash=user_id_hash,
                role=role,
                text=text,
                created_at=created_at,
                index=index,
            )
        clean_message: dict[str, Any] = {
            "message_id": message_id,
            "role": role,
            "text": text,
            "created_at": created_at,
            "provider_used": sanitize_text(str(raw.get("provider_used") or raw.get("providerUsed") or ""), 80),
            "request_id": sanitize_text(str(raw.get("request_id") or raw.get("requestId") or ""), 120),
            "mode": sanitize_text(str(raw.get("mode") or ""), 80),
            "metadata": _sanitize_metadata(raw),
        }
        if raw.get("type"):
            clean_message["type"] = sanitize_text(str(raw.get("type")), 80)
        if isinstance(raw.get("voiceCall"), dict):
            clean_message["voiceCall"] = _sanitize_voice_call(raw["voiceCall"])
        clean_messages.append(clean_message)
    return _merge_messages([], clean_messages)


def _sanitize_voice_call(raw: dict[str, Any]) -> dict[str, Any]:
    duration_ms_raw = raw.get("durationMs")
    try:
        duration_ms = max(0, min(int(duration_ms_raw or 0), 24 * 60 * 60 * 1000))
    except (TypeError, ValueError):
        duration_ms = 0
    return {
        "startTime": sanitize_text(str(raw.get("startTime") or ""), 80),
        "endTime": sanitize_text(str(raw.get("endTime") or ""), 80),
        "durationMs": duration_ms,
        "durationStr": sanitize_text(str(raw.get("durationStr") or ""), 80),
        "userTranscript": sanitize_text(str(raw.get("userTranscript") or ""), MAX_VOICE_TRANSCRIPT_CHARS),
        "aiTranscript": sanitize_text(str(raw.get("aiTranscript") or ""), MAX_VOICE_TRANSCRIPT_CHARS),
        "summary": sanitize_text(str(raw.get("summary") or ""), MAX_VOICE_SUMMARY_CHARS),
    }


def _normalize_role(value: Any) -> str:
    raw = sanitize_text(str(value or ""), MAX_ROLE_CHARS).lower()
    return "User" if raw in {"user", "human"} else "MindPal"


def _sanitize_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "safety", "ragUsed", "rag_used", "memoryUpdated", "memory_updated",
        "regenerated", "errorCode", "error_code", "providerUsed", "provider_used",
    }
    metadata: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in allowed:
            continue
        clean_key = sanitize_text(str(key), 80)
        if isinstance(value, (str, int, float, bool)) or value is None:
            metadata[clean_key] = sanitize_text(str(value), MAX_METADATA_CHARS) if isinstance(value, str) else value
        elif isinstance(value, list):
            metadata[clean_key] = [sanitize_text(str(item), 300) for item in value[:20]]
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
    return _bound_messages(merged[-MAX_MESSAGES_PER_CHAT:])



def _bound_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep newest messages while staying safely below Firestore's 1 MiB limit."""
    kept_reversed: list[dict[str, Any]] = []
    used = 512  # document metadata/headroom
    for message in reversed(messages[-MAX_MESSAGES_PER_CHAT:]):
        encoded_size = len(
            json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        ) + 32
        if kept_reversed and used + encoded_size > MAX_CHAT_DOCUMENT_BYTES:
            break
        if encoded_size > MAX_CHAT_DOCUMENT_BYTES:
            continue
        kept_reversed.append(message)
        used += encoded_size
    return list(reversed(kept_reversed))

def _chat_doc_key(user_id_hash: str) -> str:
    clean = sanitize_text(str(user_id_hash or ""), 160) or "unknown"
    return f"{clean}__{CURRENT_CHAT_ID}"


def _message_fingerprint(*, user_id_hash: str, role: str, text: str, created_at: str, index: int) -> str:
    seed = f"{user_id_hash}|{role}|{created_at}|{index}|{text}"
    return f"msg_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:24]}"


def _utcnow() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
