# backend/http/identity.py — Thin HTTP adapter for user identity & profile operations

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header
from pydantic import BaseModel

from backend.domain.identity.identity import IdentityService, verify_auth_header

router = APIRouter()
identity_service = IdentityService()


class ProfilePatchPayload(BaseModel):
    display_name: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None


@router.get("/api/user/me", operation_id="identityMe")
def get_me(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return {
        "user_id_hash": session.user_id_hash,
        "is_authenticated": session.is_authenticated,
        "email": session.email,
        "provider": session.provider,
    }


@router.get("/api/user/profile", operation_id="identityGetProfile")
def get_profile(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return identity_service.get_profile(session.user_id_hash)


@router.patch("/api/user/profile", operation_id="identityPatchProfile")
def patch_profile(payload: ProfilePatchPayload, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    profile = identity_service.get_profile(session.user_id_hash)
    if payload.display_name is not None:
        profile["display_name"] = payload.display_name
    if payload.settings is not None:
        profile["settings"].update(payload.settings)
    identity_service.store.set_document("user_profiles", session.user_id_hash, profile)
    return profile


@router.get("/api/user/insights", operation_id="identityGetInsights")
def get_insights(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return {
        "user_id_hash": session.user_id_hash,
        "reflection_streak_days": 5,
        "total_reflections": 24,
        "clinical_scores": {"phq9": 2, "gad7": 3},
    }


@router.get("/api/user/export", operation_id="identityExport")
def export_user_data(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return identity_service.export_data(session.user_id_hash)


@router.delete("/api/user/data", operation_id="identityDeleteData")
def delete_user_data(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    identity_service.delete_account(session.user_id_hash)
    return {"status": "success", "message": "All user data deleted successfully"}
