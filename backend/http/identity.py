# backend/http/identity.py — Thin HTTP adapter for user identity & profile operations

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from backend.core.errors import AppError
from backend.domain.adaptation.profile import AdaptiveProfileService
from backend.configs.runtime import api_limits_config
from backend.domain.identity.identity import (
    IdentityService,
    UserSession,
    account_guard,
    verify_auth_header,
)

router = APIRouter()
identity_service = IdentityService()

# A profile is a small settings bag, not client-controlled storage. Without a
# ceiling, PATCH /api/user/profile is an unmetered write-anything endpoint.
_IDENTITY_LIMITS = api_limits_config()["identity"]
MAX_DISPLAY_NAME_CHARS = int(_IDENTITY_LIMITS["max_display_name_chars"])
MAX_SETTINGS_KEYS = int(_IDENTITY_LIMITS["max_settings_keys"])
MAX_SETTINGS_KEY_CHARS = int(_IDENTITY_LIMITS["max_settings_key_chars"])
MAX_SETTINGS_VALUE_CHARS = int(_IDENTITY_LIMITS["max_settings_value_chars"])


class ProfilePatchPayload(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=MAX_DISPLAY_NAME_CHARS)
    settings: Optional[Dict[str, Any]] = None

    @field_validator("display_name")
    @classmethod
    def _clean_display_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return " ".join(value.split())[:MAX_DISPLAY_NAME_CHARS]

    @field_validator("settings")
    @classmethod
    def _bounded_settings(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if value is None:
            return None
        if len(value) > MAX_SETTINGS_KEYS:
            raise ValueError(f"settings supports at most {MAX_SETTINGS_KEYS} keys")
        cleaned: Dict[str, Any] = {}
        for key, item in value.items():
            name = str(key).strip()[:MAX_SETTINGS_KEY_CHARS]
            if not name:
                continue
            # Scalars only. A nested blob here is storage the product never reads.
            if item is None or isinstance(item, (bool, int, float)):
                cleaned[name] = item
            elif isinstance(item, str):
                cleaned[name] = item[:MAX_SETTINGS_VALUE_CHARS]
            else:
                raise ValueError(f"settings.{name} must be a string, number, boolean or null")
        return cleaned


@router.get("/api/user/me", operation_id="identityMe")
def get_me(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """Who the caller is. Answers for guests too — it reads no stored data."""
    session = verify_auth_header(authorization)
    return {
        "user_id_hash": session.user_id_hash,
        "is_authenticated": session.is_authenticated,
        "email": session.email,
        "provider": session.provider,
    }


@router.get("/api/user/profile", operation_id="identityGetProfile")
def get_profile(
    session: UserSession = Depends(account_guard("load your saved profile")),
) -> Dict[str, Any]:
    return identity_service.get_profile(session.user_id_hash)


@router.patch("/api/user/profile", operation_id="identityPatchProfile")
def patch_profile(
    payload: ProfilePatchPayload,
    session: UserSession = Depends(account_guard("save profile changes to your account")),
) -> Dict[str, Any]:
    # Merged inside a transaction: two devices saving different settings at
    # once each overwrote the other's keys when this was read-then-write
    # (audit MP-10).
    def merge(current: Any, write: Any) -> Dict[str, Any]:
        profile = dict(current) if isinstance(current, dict) else identity_service.get_profile(session.user_id_hash)
        if payload.display_name is not None:
            profile["display_name"] = payload.display_name
        if payload.settings is not None:
            # A profile stored before `settings` existed has no such key; `update`
            # on the missing key raised KeyError and returned a 500.
            settings = profile.get("settings")
            settings = dict(settings) if isinstance(settings, dict) else {}
            settings.update(payload.settings)
            if len(settings) > MAX_SETTINGS_KEYS:
                raise AppError(
                    "payload_invalid",
                    f"Profile settings are limited to {MAX_SETTINGS_KEYS} entries.",
                )
            profile["settings"] = settings
        write(profile)
        return profile

    return identity_service.store.transact("user_profiles", session.user_id_hash, merge)


@router.get("/api/user/insights", operation_id="identityGetInsights")
def get_insights(
    session: UserSession = Depends(account_guard("view reflection history from your account")),
) -> Dict[str, Any]:
    return identity_service.get_insights(session.user_id_hash)


@router.get("/api/user/wellness-timeline", operation_id="identityGetWellnessTimeline")
def get_wellness_timeline(
    session: UserSession = Depends(account_guard("view mood and events from account data")),
) -> Dict[str, Any]:
    return identity_service.get_wellness_timeline(session.user_id_hash)


@router.get("/api/user/export", operation_id="identityExport")
def export_user_data(
    session: UserSession = Depends(account_guard("download account data")),
) -> JSONResponse:
    payload = identity_service.export_data(session.user_id_hash)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return JSONResponse(
        content=payload,
        headers={"Content-Disposition": f'attachment; filename="mindpal-data-{stamp}.json"'},
    )


@router.delete("/api/user/data", operation_id="identityDeleteData")
def delete_user_data(
    session: UserSession = Depends(account_guard("delete account data")),
) -> Dict[str, Any]:
    result = identity_service.delete_account(session.user_id_hash)
    return {
        "status": "success",
        "deleted": result.get("deleted", []),
        "message": "Server profile, memory, and synced chats were deleted. Chat history on this device was not removed.",
    }


class ReplyFeedbackPayload(BaseModel):
    rating: str = Field(pattern="^(up|down)$")
    strategy: Optional[str] = Field(default=None, max_length=40)


@router.get("/api/user/adaptation", operation_id="identityGetAdaptation")
def get_adaptation(
    session: UserSession = Depends(account_guard("see what MindPal has learned about your preferences")),
) -> Dict[str, Any]:
    """What MindPal has learned about how to talk with this person. Style only."""
    return AdaptiveProfileService(identity_service.store).describe(session.user_id_hash)


@router.delete("/api/user/adaptation", operation_id="identityResetAdaptation")
def reset_adaptation(
    session: UserSession = Depends(account_guard("reset what MindPal has learned")),
) -> Dict[str, Any]:
    return {"reset": AdaptiveProfileService(identity_service.store).reset(session.user_id_hash)}


@router.post("/api/chat/feedback", operation_id="chatReplyFeedback")
def rate_reply(
    payload: ReplyFeedbackPayload,
    session: UserSession = Depends(account_guard("teach MindPal what helps you")),
) -> Dict[str, Any]:
    """Thumbs up/down on a reply. Rewards or penalizes the approach that produced it."""
    return AdaptiveProfileService(identity_service.store).rate(
        session.user_id_hash, payload.rating, payload.strategy or ""
    )
