from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest

from backend.core.security import hash_user_id
from backend.models.user import UserSession
from backend.services.admin_authority import AdminAuthority
from backend.services.supabase_admin_repository import SupabaseAdminRepository
from backend.services.supabase_client import SupabaseClient


@pytest.fixture
def session() -> UserSession:
    return UserSession(
        raw_user_id="firebase-uid-redacted",
        user_id_hash=hash_user_id("firebase:firebase-uid-redacted"),
        authenticated=True,
        metadata={
            "email_hash": hash_user_id("firebase-email:owner@example.com"),
            "admin": False,
        },
    )


@pytest.mark.asyncio
async def test_supabase_admin_lookup_uses_hashes_only(session: UserSession) -> None:
    response = httpx.Response(200, json=[{"is_admin": True}])
    client = AsyncMock(spec=SupabaseClient)
    client.request.return_value = response
    client.decode_json.return_value = [{"is_admin": True}]

    authority = AdminAuthority(repository=SupabaseAdminRepository(client=client))

    assert await authority.is_admin(session) is True
    params = client.request.call_args.kwargs["params"]
    assert params["firebase_user_hash"].startswith("eq.usr_")
    assert "owner@example.com" not in str(params)


@pytest.mark.asyncio
async def test_supabase_admin_lookup_fails_closed(session: UserSession) -> None:
    client = AsyncMock(spec=SupabaseClient)
    client.request.return_value = httpx.Response(200, json=[])
    client.decode_json.return_value = []

    authority = AdminAuthority(repository=SupabaseAdminRepository(client=client))

    assert await authority.is_admin(session) is False


@pytest.mark.asyncio
async def test_firestore_mode_preserves_verified_firebase_claim(session: UserSession) -> None:
    session.metadata["admin"] = True
    assert await AdminAuthority().is_admin(session) is True


@pytest.mark.asyncio
async def test_anonymous_session_is_never_admin() -> None:
    session = UserSession.anonymous()
    session.metadata["admin"] = True
    assert await AdminAuthority().is_admin(session) is False
