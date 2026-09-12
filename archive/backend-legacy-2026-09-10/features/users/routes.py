# backend/features/users/routes.py

"""
User profile and session HTTP endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import (
    AuthenticatedRequestContextDep,
    ServicesDep,
    assert_authenticated,
    http_error_from_app_error,
)
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from .schemas import UserProfile, UserProfileUpdate

router = APIRouter(prefix="/api/user", tags=["user"])

MAX_PROVIDER_CHARS = 80
MAX_SESSION_HASH_CHARS = 120


class CurrentUserResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=120)
    user_id_hash: str = Field(min_length=1, max_length=MAX_SESSION_HASH_CHARS)
    authenticated: bool = True
    channel: str = Field(default="web", min_length=1, max_length=80)
    locale: str = Field(default="auto", min_length=1, max_length=20)
    provider: str = Field(default="firebase", min_length=1, max_length=MAX_PROVIDER_CHARS)
    email_verified: bool | None = None
    is_admin: bool = False

    @field_validator("request_id", "user_id_hash", "channel", "locale", "provider", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("field cannot be empty")
        return cleaned


class UserProfileResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    profile: UserProfile


@router.get("/me", response_model=CurrentUserResponse)
async def current_user(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> CurrentUserResponse:
    assert_authenticated(context)
    metadata = getattr(context.session, "metadata", {}) or {}
    provider = sanitize_text(str(metadata.get("provider", "firebase")), MAX_PROVIDER_CHARS) or "firebase"
    email_verified = metadata.get("email_verified") if isinstance(metadata.get("email_verified"), bool) else None
    is_admin = await services.admin_authority.is_admin(context.session)

    return CurrentUserResponse(
        request_id=context.request_id,
        user_id_hash=context.session.user_id_hash,
        authenticated=True,
        channel=context.session.channel.value if hasattr(context.session.channel, "value") else str(context.session.channel),
        locale=context.session.locale,
        provider=provider,
        email_verified=email_verified,
        is_admin=is_admin,
    )


@router.get("/profile", response_model=UserProfileResponse)
async def load_profile(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    assert_authenticated(context)
    try:
        profile = await services.db.load_user_profile(context.session.user_id_hash)
        return UserProfileResponse(profile=profile)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "user_profile_load_failed", "message": "Failed to load user profile", "request_id": context.request_id},
        ) from exc


@router.patch("/profile", response_model=UserProfileResponse)
async def update_profile(
    payload: UserProfileUpdate,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    assert_authenticated(context)
    try:
        profile = await services.db.update_user_profile(context.session.user_id_hash, payload)
        return UserProfileResponse(profile=profile)
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "user_profile_update_failed", "message": "Failed to update profile", "request_id": context.request_id},
        ) from exc
