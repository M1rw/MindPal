# backend/http/flags.py — Thin HTTP adapter for feature flags

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header

from backend.domain.flags.flags import FeatureFlagsService
from backend.domain.identity.identity import verify_auth_header

router = APIRouter()
flags_service = FeatureFlagsService()


@router.get("/api/features", operation_id="flagsSnapshot")
def get_flags_snapshot(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    session = verify_auth_header(authorization)
    return flags_service.get_flags_snapshot(session.user_id_hash)
