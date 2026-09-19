# backend/http/release.py — Thin HTTP adapter for release changelog operations

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel, Field

from backend.domain.identity.identity import UserSession, account_guard, verify_auth_header
from backend.domain.release.changelog import ReleaseService

router = APIRouter()
release_service = ReleaseService()

MAX_VERSION_CHARS = 40


class DismissPayload(BaseModel):
    version: str = Field(max_length=MAX_VERSION_CHARS)


@router.get("/api/release/changelog", operation_id="releaseChangelogGet")
def get_changelog(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """The release notes, plus this account's dismissals.

    A guest gets the notes with an empty dismissal list. A bad credential is a
    401: the old handler swallowed the failure and served the shared
    "anonymous" record instead, which is how one visitor's dismissal hid a
    release from everyone else who was signed out.
    """
    session = verify_auth_header(authorization)
    return release_service.get_changelog(session.user_id_hash)


@router.post("/api/release/changelog", operation_id="releaseChangelogDismiss", status_code=204)
def dismiss_changelog(
    payload: DismissPayload,
    session: UserSession = Depends(account_guard("keep release notes dismissed across devices")),
) -> Response:
    release_service.dismiss_changelog(session.user_id_hash, payload.version)
    return Response(status_code=204)
