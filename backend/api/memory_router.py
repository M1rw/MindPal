# backend/api/memory_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import AuthenticatedRequestContextDep, ServicesDep
from backend.core.errors import AppError
from backend.core.security import normalize_locale, sanitize_text
from backend.models.memory import (
    MemoryCompactionRequest,
    MemoryCompactionResult,
    MemoryInteraction,
    MemoryLoadResult,
    MemorySummary,
    MemoryWriteResult,
)


router = APIRouter(prefix="/api/memory", tags=["memory"])

MAX_MEMORY_INTERACTIONS = 50
MAX_CLIENT_MEMORY_ITEMS = 80
MAX_SESSION_HASH_CHARS = 120


class MemorySummarizePayload(BaseModel):
    """
    Explicit memory compaction payload.

    user_id_hash is intentionally absent. The route always uses the verified
    Firebase session hash to prevent client-side spoofing.

    This route requires authentication.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    interactions: list[MemoryInteraction] = Field(
        default_factory=list,
        max_length=MAX_MEMORY_INTERACTIONS,
    )
    force: bool = False
    save: bool = True
    locale: str = "auto"

    @field_validator("locale", mode="before")
    @classmethod
    def _clean_locale(cls, value: object) -> str:
        return normalize_locale(str(value or "auto"))


class MemorySavePayload(BaseModel):
    """
    Explicit memory overwrite/update payload.

    The submitted summary is re-bound to the verified Firebase session hash
    before persistence.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    summary: MemorySummary


@router.get("", response_model=MemoryLoadResult)
async def load_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryLoadResult:
    """
    Load the authenticated user's memory summary.

    Does not expose memory for arbitrary user IDs.
    Anonymous sessions are not allowed.
    """
    _assert_authenticated(context)

    try:
        return await services.db.load_memory(context.session.user_id_hash)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_load_failed",
                "message": "Failed to load memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/summarize", response_model=MemoryCompactionResult)
async def summarize_memory(
    payload: MemorySummarizePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryCompactionResult:
    """
    Compact sanitized interaction fragments into authenticated user memory.

    Flow:
    - require verified Firebase session
    - load existing memory for current session
    - run LLM-primary memory compaction with local fallback
    - optionally persist only if changed and save=true
    """
    _assert_authenticated(context)

    try:
        locale = payload.locale if payload.locale != "auto" else context.locale

        existing = await services.db.load_memory(context.session.user_id_hash)
        existing_summary = existing.summary

        compaction = await services.memory.compact(
            MemoryCompactionRequest(
                request_id=context.request_id,
                user_id_hash=context.session.user_id_hash,
                existing_summary=existing_summary,
                interactions=payload.interactions,
                locale=locale,
                force=payload.force,
            )
        )

        if payload.save and compaction.changed:
            safe_summary = _summary_for_session(
                compaction.summary,
                user_id_hash=context.session.user_id_hash,
            )
            await services.db.save_memory(safe_summary)

        return compaction

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_summarize_failed",
                "message": "Failed to summarize memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.put("", response_model=MemoryWriteResult)
async def save_memory(
    payload: MemorySavePayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    """
    Save/replace the authenticated user's memory summary.

    The client cannot choose the target user hash. The submitted summary is
    always re-bound to context.session.user_id_hash.
    """
    _assert_authenticated(context)

    try:
        summary = _summary_for_session(
            payload.summary,
            user_id_hash=context.session.user_id_hash,
        )
        return await services.db.save_memory(summary)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_save_failed",
                "message": "Failed to save memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.delete("", response_model=MemoryWriteResult)
async def delete_memory(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MemoryWriteResult:
    """
    Delete the authenticated user's memory summary.
    """
    _assert_authenticated(context)

    try:
        return await services.db.delete_memory(context.session.user_id_hash)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "memory_delete_failed",
                "message": "Failed to delete memory",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("/health")
async def memory_health(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """
    Memory subsystem health.

    Does not return memory contents. Auth is still required because this route
    belongs to the memory surface.
    """
    _assert_authenticated(context)

    return {
        "request_id": context.request_id,
        "authenticated": True,
        "memory": services.memory.health(),
    }


def _summary_for_session(summary: MemorySummary, *, user_id_hash: str) -> MemorySummary:
    """
    Rebind a MemorySummary to the authenticated session user.

    This prevents a client from submitting a summary for another user_id_hash.
    Uses model_copy to preserve model fields added later.
    """
    clean_user_hash = sanitize_text(user_id_hash, MAX_SESSION_HASH_CHARS)

    if not clean_user_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_authenticated_session",
                "message": "Authenticated session is missing a stable user hash",
            },
        )

    return summary.model_copy(
        update={
            "user_id_hash": clean_user_hash,
            "known_triggers": summary.known_triggers[:MAX_CLIENT_MEMORY_ITEMS],
            "preferred_coping_tools": summary.preferred_coping_tools[:MAX_CLIENT_MEMORY_ITEMS],
            "goals": summary.goals[:MAX_CLIENT_MEMORY_ITEMS],
            "preferences": summary.preferences[:MAX_CLIENT_MEMORY_ITEMS],
            "safety_flags": summary.safety_flags[:MAX_CLIENT_MEMORY_ITEMS],
            "items": summary.items[:MAX_CLIENT_MEMORY_ITEMS],
            "version": max(1, summary.version),
        }
    )


def _assert_authenticated(context: Any) -> None:
    session = getattr(context, "session", None)

    if session is None or not getattr(session, "authenticated", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "authentication_required",
                "message": "Authentication is required for memory operations",
                "request_id": getattr(context, "request_id", None),
            },
        )


def _http_error_from_app_error(exc: AppError) -> HTTPException:
    status_code = getattr(exc, "status_code", None) or status.HTTP_500_INTERNAL_SERVER_ERROR
    code = getattr(exc, "code", None) or exc.__class__.__name__
    message = sanitize_text(str(exc), 500) or "Application error"
    details = getattr(exc, "details", None) or {}

    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details,
        },
    )