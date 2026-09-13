# backend/http/release.py — Thin HTTP adapter for release changelog operations

from __future__ import annotations

from typing import Dict, Any, Optional
from fastapi import APIRouter, Header, Response
from pydantic import BaseModel

from backend.domain.identity.identity import verify_auth_header
from backend.domain.release.changelog import ReleaseService

router = APIRouter()
release_service = ReleaseService()


class DismissPayload(BaseModel):
    version: str


@router.get("/api/release/changelog", operation_id="releaseChangelogGet")
def get_changelog(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    user_id_hash = "anonymous"
    if authorization:
        try:
            session = verify_auth_header(authorization)
            user_id_hash = session.user_id_hash
        except Exception:
            pass
    return release_service.get_changelog(user_id_hash)


@router.post("/api/release/changelog", operation_id="releaseChangelogDismiss", status_code=204)
def dismiss_changelog(payload: DismissPayload, authorization: Optional[str] = Header(None)) -> Response:
    user_id_hash = "anonymous"
    if authorization:
        try:
            session = verify_auth_header(authorization)
            user_id_hash = session.user_id_hash
        except Exception:
            pass
    release_service.dismiss_changelog(user_id_hash, payload.version)
    return Response(status_code=204)
