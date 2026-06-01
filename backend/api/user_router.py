# backend/api/user_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import RequestContextDep, ServicesDep
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.models.user import (
    UserProfile,
    UserProfileResponse,
    UserProfileUpdate,
)


router = APIRouter(prefix="/api/user", tags=["user"])

MAX_PROVIDER_CHARS = 80
MAX_PROFILE_ITEMS = 50


class CurrentUserResponse(BaseModel):
    """
    Public current-user/session view.

    Deliberately does not expose raw_user_id, bearer tokens, cookies, Firebase
    payloads, or provider secrets.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=120)
    user_id_hash: str = Field(min_length=1, max_length=80)
    authenticated: bool = False
    channel: str = Field(default="web", min_length=1, max_length=80)
    locale: str = Field(default="auto", min_length=1, max_length=20)
    provider: str = Field(default="anonymous", min_length=1, max_length=MAX_PROVIDER_CHARS)

    @field_validator("request_id", "user_id_hash", "channel", "locale", "provider", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


class UserProfileReplacePayload(BaseModel):
    """
    Full profile replacement payload.

    Submitted user_id_hash is ignored and rebound to current session hash.
    Prefer PATCH /profile for normal updates.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    profile: UserProfile


@router.get("/me", response_model=CurrentUserResponse)
async def current_user(
    context: RequestContextDep,
) -> CurrentUserResponse:
    """
    Return sanitized current session identity.
    """
    provider = str(context.session.metadata.get("provider", "anonymous"))

    return CurrentUserResponse(
        request_id=context.request_id,
        user_id_hash=context.session.user_id_hash,
        authenticated=context.session.authenticated,
        channel=context.session.channel.value,
        locale=context.session.locale,
        provider=provider,
    )


@router.get("/profile", response_model=UserProfileResponse)
async def load_profile(
    services: ServicesDep,
    context: RequestContextDep,
) -> UserProfileResponse:
    """
    Load current user's profile.

    Does not accept arbitrary user IDs.
    """
    try:
        return await services.db.load_user_profile(context.session.user_id_hash)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "user_profile_load_failed",
                "message": "Failed to load user profile",
                "request_id": context.request_id,
            },
        ) from exc


@router.patch("/profile", response_model=UserProfileResponse)
async def update_profile(
    payload: UserProfileUpdate,
    services: ServicesDep,
    context: RequestContextDep,
) -> UserProfileResponse:
    """
    Partially update current user's profile.

    The target profile is always context.session.user_id_hash.
    """
    try:
        return await services.db.update_user_profile(
            context.session.user_id_hash,
            payload,
        )

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "user_profile_update_failed",
                "message": "Failed to update user profile",
                "request_id": context.request_id,
            },
        ) from exc


@router.put("/profile", response_model=UserProfileResponse)
async def replace_profile(
    payload: UserProfileReplacePayload,
    services: ServicesDep,
    context: RequestContextDep,
) -> UserProfileResponse:
    """
    Replace current user's profile.

    Client-submitted user_id_hash is ignored to prevent spoofing.
    """
    try:
        profile = _profile_for_session(
            payload.profile,
            user_id_hash=context.session.user_id_hash,
        )
        return await services.db.save_user_profile(profile)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "user_profile_replace_failed",
                "message": "Failed to replace user profile",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/profile/reset", response_model=UserProfileResponse)
async def reset_profile(
    services: ServicesDep,
    context: RequestContextDep,
) -> UserProfileResponse:
    """
    Reset current user's profile to defaults.

    This preserves the session user_id_hash and does not delete memory.
    """
    try:
        profile = UserProfile(
            user_id_hash=context.session.user_id_hash,
            channel=context.session.channel,
        )
        return await services.db.save_user_profile(profile)

    except AppError as exc:
        raise _http_error_from_app_error(exc) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "user_profile_reset_failed",
                "message": "Failed to reset user profile",
                "request_id": context.request_id,
            },
        ) from exc


@router.get("/health")
async def user_health(
    services: ServicesDep,
    context: RequestContextDep,
) -> dict[str, Any]:
    """
    User subsystem health.

    Does not expose profile contents.
    """
    auth_health = services.auth.health()
    db_health = await services.db.health()

    return {
        "request_id": context.request_id,
        "auth": {
            "provider_configured": auth_health["provider_configured"],
            "allow_anonymous": auth_health["allow_anonymous"],
            "trusts_unverified_bearer_tokens": auth_health["trusts_unverified_bearer_tokens"],
        },
        "db": {
            "provider": db_health["provider"],
            "mock_mode": db_health["mock_mode"],
        },
    }


def _profile_for_session(profile: UserProfile, *, user_id_hash: str) -> UserProfile:
    """
    Rebind a UserProfile to the current session.

    Prevents client-submitted profile.user_id_hash from targeting another user.
    """
    return UserProfile(
        user_id_hash=sanitize_text(user_id_hash, 80),
        status=profile.status,
        channel=profile.channel,
        preferences=profile.preferences,
        notes=profile.notes,
        metadata=profile.metadata,
        created_at=profile.created_at,
        updated_at=profile.updated_at,
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