from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pydantic import SecretStr

import importlib

voice_router = importlib.import_module("backend.api.voice_router")


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        request_id="req-voice-test",
        session=SimpleNamespace(authenticated=True, user_id_hash="user-test"),
    )


@pytest.mark.asyncio
async def test_voice_token_endpoint_returns_ephemeral_token_not_provider_key(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = SimpleNamespace(
        GEMINI_API_KEY=SecretStr("permanent-provider-secret"),
        GEMINI_LIVE_MODEL="gemini-3.1-flash-live-preview",
        VOICE_TOKEN_TTL_SECONDS=1800,
        VOICE_NEW_SESSION_TTL_SECONDS=60,
    )

    async def fake_create(**_: object) -> str:
        return "ephemeral-session-token"

    monkeypatch.setattr(voice_router, "get_settings", lambda: settings)
    monkeypatch.setattr(voice_router, "_create_ephemeral_voice_token", fake_create)

    response = Response()
    result = await voice_router.get_voice_token(response=response, context=_context())

    assert result.token == "ephemeral-session-token"
    assert result.token != settings.GEMINI_API_KEY.get_secret_value()
    assert "BidiGenerateContentConstrained" in result.websocket_url
    assert response.headers["cache-control"] == "no-store, private"


@pytest.mark.asyncio
async def test_retired_voice_key_endpoint_never_returns_secret() -> None:
    with pytest.raises(HTTPException) as exc_info:
        await voice_router.retired_voice_key_endpoint(context=_context())
    assert exc_info.value.status_code == 410
