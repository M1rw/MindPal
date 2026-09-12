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
def get_changelog() -> Dict[str, Any]:
    return release_service.get_changelog()


@router.post("/api/release/changelog", operation_id="releaseChangelogDismiss", status_code=204)
def dismiss_changelog(payload: DismissPayload, authorization: Optional[str] = Header(None)) -> Response:
    session = verify_auth_header(authorization)
    release_service.dismiss_changelog(session.user_id_hash, payload.version)
    return Response(status_code=204)
