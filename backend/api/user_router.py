# backend/api/user_router.py

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.api.dependencies import AuthenticatedRequestContextDep, ServicesDep
from backend.core.errors import AppError
from backend.core.security import sanitize_text
from backend.models.user import (
    UserProfile,
    UserProfileResponse,
    UserProfileUpdate,
)


router = APIRouter(prefix="/api/user", tags=["user"])

MAX_PROVIDER_CHARS = 80
MAX_SESSION_HASH_CHARS = 120


class CurrentUserResponse(BaseModel):
    """
    Sanitized authenticated user/session view.

    Deliberately does not expose:
    - raw Firebase UID
    - bearer tokens
    - cookies
    - Firebase decoded token payload
    - provider credentials
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: str = Field(min_length=1, max_length=120)
    user_id_hash: str = Field(min_length=1, max_length=MAX_SESSION_HASH_CHARS)
    authenticated: bool = True
    channel: str = Field(default="web", min_length=1, max_length=80)
    locale: str = Field(default="auto", min_length=1, max_length=20)
    provider: str = Field(default="firebase", min_length=1, max_length=MAX_PROVIDER_CHARS)
    email_verified: bool | None = None

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

    Submitted user_id_hash is ignored and rebound to the verified Firebase
    session hash. Prefer PATCH /profile for normal updates.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    profile: UserProfile


@router.get("/me", response_model=CurrentUserResponse)
async def current_user(
    context: AuthenticatedRequestContextDep,
) -> CurrentUserResponse:
    """
    Return sanitized authenticated session identity.

    Requires Firebase authentication.
    """
    _assert_authenticated(context)

    provider = sanitize_text(
        str(context.session.metadata.get("provider", "firebase")),
        MAX_PROVIDER_CHARS,
    ) or "firebase"

    raw_email_verified = context.session.metadata.get("email_verified")
    email_verified = raw_email_verified if isinstance(raw_email_verified, bool) else None

    return CurrentUserResponse(
        request_id=context.request_id,
        user_id_hash=context.session.user_id_hash,
        authenticated=True,
        channel=context.session.channel.value,
        locale=context.session.locale,
        provider=provider,
        email_verified=email_verified,
    )


@router.get("/profile", response_model=UserProfileResponse)
async def load_profile(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    """
    Load authenticated user's profile.

    Does not accept arbitrary user IDs.
    Anonymous sessions are not allowed.
    """
    _assert_authenticated(context)

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
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    """
    Partially update authenticated user's profile.

    The target profile is always context.session.user_id_hash.
    """
    _assert_authenticated(context)

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
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    """
    Replace authenticated user's profile.

    Client-submitted user_id_hash is ignored to prevent spoofing.
    """
    _assert_authenticated(context)

    try:
        profile = _profile_for_session(
            payload.profile,
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
                "code": "user_profile_replace_failed",
                "message": "Failed to replace user profile",
                "request_id": context.request_id,
            },
        ) from exc


@router.post("/profile/reset", response_model=UserProfileResponse)
async def reset_profile(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    """
    Reset authenticated user's profile to defaults.

    This preserves the verified session user_id_hash and does not delete memory.
    """
    _assert_authenticated(context)

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
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """
    User subsystem health.

    Requires authentication because this route belongs to the user surface.
    Does not expose profile contents.
    """
    _assert_authenticated(context)

    auth_health = services.auth.health()
    db_health = await services.db.health()

    return {
        "request_id": context.request_id,
        "authenticated": True,
        "auth": {
            "provider": auth_health["provider"],
            "provider_configured": auth_health["provider_configured"],
            "allow_anonymous": auth_health["allow_anonymous"],
            "trusts_unverified_bearer_tokens": auth_health["trusts_unverified_bearer_tokens"],
            "invalid_bearer_falls_back_to_anonymous": auth_health.get(
                "invalid_bearer_falls_back_to_anonymous",
                False,
            ),
        },
        "db": {
            "provider": db_health["provider"],
            "mock_mode": db_health["mock_mode"],
            "database_id": db_health.get("database_id"),
        },
    }


def _profile_for_session(
    profile: UserProfile,
    *,
    user_id_hash: str,
    channel: Any,
) -> UserProfile:
    """
    Rebind a UserProfile to the authenticated session.

    Prevents client-submitted profile.user_id_hash from targeting another user.
    Uses model_copy to preserve future model fields.
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

    return profile.model_copy(
        update={
            "user_id_hash": clean_user_hash,
            "channel": channel,
        }
    )


def _assert_authenticated(context: Any) -> None:
    session = getattr(context, "session", None)

    if session is None or not getattr(session, "authenticated", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "authentication_required",
                "message": "Authentication is required for user operations",
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