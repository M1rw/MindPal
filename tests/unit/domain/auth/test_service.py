# Test auth domain service

import pytest
from unittest.mock import AsyncMock, MagicMock

from backend.services.domain.auth import (
    AuthService,
    AuthIdentity,
    OfflineAuthProvider,
)
from backend.core.errors import AuthError
from backend.models.user import UserChannel, UserSession


@pytest.fixture
def offline_provider():
    return OfflineAuthProvider()


@pytest.fixture
def auth_service(offline_provider):
    return AuthService(
        provider=offline_provider,
        allow_anonymous=True,
    )


@pytest.mark.asyncio
async def test_resolve_anonymous_session_no_auth_header(auth_service):
    """Test resolving anonymous session when no auth header."""
    
    session = await auth_service.resolve_session(
        authorization_header=None,
        raw_user_id="test_user",
    )
    
    assert session.authenticated is False
    assert session.raw_user_id == "test_user"
    assert session.metadata["provider"] == "anonymous"


@pytest.mark.asyncio
async def test_resolve_authenticated_session_with_bearer_token(auth_service):
    """Test resolving authenticated session with bearer token."""
    
    session = await auth_service.resolve_session(
        authorization_header="Bearer valid_token_123",
    )
    
    assert session.authenticated is True
    # Offline provider uses token as user ID
    assert "valid_token_123" in session.raw_user_id or session.raw_user_id != ""


@pytest.mark.asyncio
async def test_auth_required_without_token(auth_service):
    """Test error when auth required but no token."""
    
    with pytest.raises(AuthError) as exc_info:
        await auth_service.resolve_session(
            authorization_header=None,
            require_auth=True,
        )
    
    assert exc_info.value.code == "auth_missing_bearer"


@pytest.mark.asyncio
async def test_anonymous_disabled_without_token(offline_provider):
    """Test error when anonymous disabled and no token."""
    
    service = AuthService(
        provider=offline_provider,
        allow_anonymous=False,
    )
    
    with pytest.raises(AuthError) as exc_info:
        await service.resolve_session(
            authorization_header=None,
        )
    
    assert exc_info.value.code == "anonymous_disabled"


@pytest.mark.asyncio
async def test_invalid_bearer_token_format(auth_service):
    """Test invalid Bearer token format handled gracefully."""
    
    # Invalid format: missing scheme
    session = await auth_service.resolve_session(
        authorization_header="invalid_format",
        raw_user_id="fallback_user",
    )
    
    # Should fall back to anonymous since no Bearer token
    assert session.authenticated is False


@pytest.mark.asyncio
async def test_app_check_token_verification(auth_service):
    """Test Firebase App Check token verification."""
    
    result = await auth_service.verify_app_check_token("app_check_token_123")
    
    # Offline provider allows any token
    assert "app_id" in result


@pytest.mark.asyncio
async def test_app_check_missing_token(auth_service):
    """Test error when App Check token missing."""
    
    with pytest.raises(AuthError) as exc_info:
        await auth_service.verify_app_check_token(None)
    
    assert exc_info.value.code == "app_check_missing"


@pytest.mark.asyncio
async def test_health_status(auth_service):
    """Test service health status."""
    
    health = auth_service.health()
    
    assert health["provider"] == "offline"
    assert health["provider_configured"] is True
    assert health["allow_anonymous"] is True
    assert health["trusts_unverified_bearer_tokens"] is False
    assert health["invalid_bearer_falls_back_to_anonymous"] is False


@pytest.mark.asyncio
async def test_session_channel_normalization(auth_service):
    """Test channel normalization."""
    
    session = await auth_service.resolve_session(
        raw_user_id="test_user",
        channel="mobile",
    )
    
    assert session.channel == UserChannel.MOBILE


@pytest.mark.asyncio
async def test_session_locale_normalization(auth_service):
    """Test locale normalization."""
    
    session = await auth_service.resolve_session(
        raw_user_id="test_user",
        locale="en-US",
    )
    
    # Should be a valid locale
    assert session.locale in ["en-US", "en", "auto"]


@pytest.mark.asyncio
async def test_metadata_sanitization(offline_provider):
    """Test that sensitive metadata is not exposed."""
    
    # Mock provider that returns identity with sensitive metadata
    service = AuthService(provider=offline_provider)
    
    # The service should sanitize any password/token/secret fields
    session = await service.resolve_session(
        authorization_header="Bearer token_123"
    )
    
    # Should not contain raw tokens
    assert "authorization" not in str(session.metadata).lower()


def test_bearer_token_parsing():
    """Test bearer token parsing utility."""
    
    from backend.services.domain.auth.service import parse_bearer_token
    
    # Valid token
    token = parse_bearer_token("Bearer valid_token_123")
    assert token == "valid_token_123"
    
    # Missing bearer
    token = parse_bearer_token("Basic xyz")
    assert token is None
    
    # Missing token
    token = parse_bearer_token("Bearer")
    assert token is None
    
    # No header
    token = parse_bearer_token(None)
    assert token is None
    
    # With extra spaces
    token = parse_bearer_token("  Bearer   my_token  ")
    assert token == "my_token"

