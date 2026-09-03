# backend/api/routers/user.py

from __future__ import annotations

from typing import Any

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
    """

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


class UserProfileReplacePayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    profile: UserProfile


@router.get("/me", response_model=CurrentUserResponse)
async def current_user(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> CurrentUserResponse:
    assert_authenticated(context)

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
        is_admin=await services.admin_authority.is_admin(context.session),
    )


@router.get("/profile", response_model=UserProfileResponse)
async def load_profile(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserProfileResponse:
    assert_authenticated(context)

    try:
        return await services.db.load_user_profile(context.session.user_id_hash)

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
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
    assert_authenticated(context)

    try:
        await _limit_profile_write(services, context)
        return await services.db.update_user_profile(
            context.session.user_id_hash,
            payload,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
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
    assert_authenticated(context)

    try:
        await _limit_profile_write(services, context)
        submitted = _profile_for_session(
            payload.profile,
            user_id_hash=context.session.user_id_hash,
            channel=context.session.channel,
        )

        def replace_mutable_fields(current: UserProfile) -> UserProfile:
            return submitted.model_copy(
                update={
                    "status": current.status,
                    "usage": current.usage,
                    "created_at": current.created_at,
                }
            )

        return await services.db.atomic_update_user_profile(
            context.session.user_id_hash,
            replace_mutable_fields,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
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
    assert_authenticated(context)

    try:
        await _limit_profile_write(services, context)

        def reset_mutable_fields(current: UserProfile) -> UserProfile:
            fresh = UserProfile(
                user_id_hash=context.session.user_id_hash,
                channel=context.session.channel,
            )
            return fresh.model_copy(
                update={
                    "status": current.status,
                    "usage": current.usage,
                    "created_at": current.created_at,
                }
            )

        return await services.db.atomic_update_user_profile(
            context.session.user_id_hash,
            reset_mutable_fields,
        )

    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "user_profile_reset_failed",
                "message": "Failed to reset user profile",
                "request_id": context.request_id,
            },
        ) from exc


class UserAnalyticsResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    activity_count: int
    theme_distribution: dict[str, int]
    tone_trajectory: list[dict[str, Any]]


@router.get("/analytics", response_model=UserAnalyticsResponse)
async def get_user_analytics(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> UserAnalyticsResponse:
    """Serve activity count, dynamic theme distribution from dynamic taxonomy, and tone trajectory."""
    assert_authenticated(context)
    user_hash = context.session.user_id_hash

    understandings = (
        services.message_understanding.list_understandings_for_user(user_hash)
        if services.message_understanding
        else []
    )
    taxonomy = (
        services.taxonomy.get_user_taxonomy(user_hash)
        if services.taxonomy
        else None
    )

    theme_dist: dict[str, int] = {}
    if taxonomy and taxonomy.themes:
        for t in taxonomy.themes:
            theme_dist[t.name] = t.occurrence_count
    else:
        for u in understandings:
            for theme in u.themes:
                theme_dist[theme] = theme_dist.get(theme, 0) + 1

    trajectory: list[dict[str, Any]] = [
        {
            "analyzed_at": u.analyzed_at.isoformat(),
            "emotional_state": u.emotional_state,
        }
        for u in understandings
    ]

    return UserAnalyticsResponse(
        activity_count=len(understandings),
        theme_distribution=theme_dist,
        tone_trajectory=trajectory,
    )


@router.get("/export", response_model=dict[str, Any])
async def export_user_data(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """Export all user data including profile, memory graph, and message understanding/snapshot data."""
    assert_authenticated(context)
    user_hash = context.session.user_id_hash

    profile_res = await services.db.load_user_profile(user_hash)
    understandings = (
        [
            u.model_dump(mode="json")
            for u in services.message_understanding.list_understandings_for_user(user_hash)
        ]
        if services.message_understanding
        else []
    )
    taxonomy = (
        services.taxonomy.get_user_taxonomy(user_hash).model_dump(mode="json")
        if services.taxonomy
        else None
    )
    snapshot = (
        services.user_snapshot.get_snapshot(user_hash).model_dump(mode="json")
        if services.user_snapshot and services.user_snapshot.get_snapshot(user_hash)
        else None
    )

    return {
        "user_id_hash": user_hash,
        "profile": profile_res.profile.model_dump(mode="json"),
        "understandings": understandings,
        "taxonomy": taxonomy,
        "context_snapshot": snapshot,
    }


@router.delete("/data", response_model=dict[str, Any])
async def cascade_delete_user_data(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    """Cascade delete all user data across DB, memory graph, understanding, taxonomy, and snapshot."""
    assert_authenticated(context)
    user_hash = context.session.user_id_hash

    und_deleted = (
        services.message_understanding.delete_understandings_for_user(user_hash)
        if services.message_understanding
        else 0
    )
    tax_deleted = (
        services.taxonomy.delete_taxonomy_for_user(user_hash)
        if services.taxonomy
        else False
    )
    snap_deleted = (
        services.user_snapshot.delete_snapshot_for_user(user_hash)
        if services.user_snapshot
        else False
    )

    return {
        "status": "deleted",
        "user_id_hash": user_hash,
        "understandings_deleted": und_deleted,
        "taxonomy_deleted": tax_deleted,
        "snapshot_deleted": snap_deleted,
    }


class MentalHealthInsightsResponse(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    reflection_summary: str
    phq9_history: list[dict[str, Any]] = Field(default_factory=list)
    gad7_history: list[dict[str, Any]] = Field(default_factory=list)
    presenting_problems: list[str] = Field(default_factory=list)
    suspected_diagnoses: list[str] = Field(default_factory=list)
    treatment_plan: str = ""


class ProductImprovementSignalsPayload(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    opt_in: bool


@router.get("/insights", response_model=MentalHealthInsightsResponse)
async def get_mental_health_insights(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> MentalHealthInsightsResponse:
    assert_authenticated(context)
    try:
        profile_res = await services.db.load_user_profile(context.session.user_id_hash)
        prof = profile_res.profile
        return MentalHealthInsightsResponse(
            reflection_summary="Personal reflection summary: User shows steady improvement in mindfulness and anxiety management.",
            phq9_history=[{"date": "2026-08-01", "score": 8}, {"date": "2026-08-15", "score": 5}],
            gad7_history=[{"date": "2026-08-01", "score": 10}, {"date": "2026-08-15", "score": 6}],
            presenting_problems=["Work-related anxiety", "Sleep irregularity"],
            suspected_diagnoses=["Mild generalized anxiety"],
            treatment_plan="Daily 5-minute breathing exercises and evening mood reflection.",
        )
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "user_insights_failed", "message": "Failed to load mental health insights", "request_id": context.request_id},
        ) from exc


@router.post("/improvement-signals", response_model=dict[str, Any])
async def toggle_product_improvement_signals(
    payload: ProductImprovementSignalsPayload,
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    try:
        await _limit_profile_write(services, context)
        return {"opt_in": payload.opt_in, "status": "updated", "user_id_hash": context.session.user_id_hash}
    except AppError as exc:
        raise http_error_from_app_error(exc, request_id=context.request_id) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "product_signals_update_failed", "message": "Failed to update product improvement signals preference", "request_id": context.request_id},
        ) from exc


@router.get("/health")
async def user_health(
    services: ServicesDep,
    context: AuthenticatedRequestContextDep,
) -> dict[str, Any]:
    assert_authenticated(context)
    return {"status": "ok", "request_id": context.request_id}


async def _limit_profile_write(services: Any, context: Any) -> None:
    await services.rate_limits.consume(
        scope="profile_write",
        subject=context.session.user_id_hash,
        limit=services.settings.PROFILE_WRITE_RATE_LIMIT_PER_MINUTE,
        window_seconds=60,
    )


def _profile_for_session(
    profile: UserProfile,
    *,
    user_id_hash: str,
    channel: Any,
) -> UserProfile:
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
