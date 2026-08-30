# Integration tests for service bootstrap

import pytest
from backend.services.bootstrap import bootstrap_services, create_app_container
from backend.services.domain.auth import AuthService, OfflineAuthProvider


@pytest.mark.asyncio
async def test_bootstrap_services_complete(monkeypatch):
    """Test complete bootstrap process."""
    
    # Use offline mode for testing
    monkeypatch.setenv("OFFLINE_MODE", "true")
    
    container = await bootstrap_services(offline_mode=True)
    
    # Should have auth service registered
    auth_service = await container.resolve("auth_service")
    
    assert isinstance(auth_service, AuthService)
    assert isinstance(auth_service.provider, OfflineAuthProvider)
    
    # Cleanup
    await container.shutdown()


@pytest.mark.asyncio
async def test_create_app_container_integration():
    """Test full app container creation."""
    
    container = await create_app_container()
    
    # Should be initialized
    auth_service = await container.resolve("auth_service")
    assert auth_service is not None
    
    # Test auth service works
    session = await auth_service.resolve_session(
        raw_user_id="test_user",
    )
    assert session.authenticated is False
    
    # Cleanup
    await container.shutdown()


@pytest.mark.asyncio
async def test_auth_service_health_check():
    """Test auth service health check."""
    
    container = await create_app_container()
    auth_service = await container.resolve("auth_service")
    
    health = auth_service.health()
    
    assert health["provider"] is not None
    assert "provider_configured" in health
    assert "allow_anonymous" in health
    
    await container.shutdown()

