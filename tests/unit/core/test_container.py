# Test service container

import pytest
from backend.services.core.container import ServiceContainer, ServiceNotFoundError


@pytest.fixture
def container():
    return ServiceContainer()


@pytest.mark.asyncio
async def test_register_and_resolve_singleton(container):
    """Test basic singleton registration and resolution."""
    
    class MockService:
        def __init__(self, value: str):
            self.value = value
    
    service = MockService("test")
    container.register_singleton("mock", service)
    
    resolved = await container.resolve("mock")
    assert resolved is service
    assert resolved.value == "test"


@pytest.mark.asyncio
async def test_resolve_factory(container):
    """Test factory-based service resolution."""
    
    async def create_service():
        return {"initialized": True}
    
    container.register_factory("service", create_service)
    resolved = await container.resolve("service")
    
    assert resolved == {"initialized": True}


@pytest.mark.asyncio
async def test_service_not_found(container):
    """Test error when service not found."""
    
    with pytest.raises(ServiceNotFoundError):
        await container.resolve("nonexistent")


@pytest.mark.asyncio
async def test_lifecycle_hooks(container):
    """Test service lifecycle hooks."""
    
    class MockService:
        def __init__(self):
            self.started = False
            self.stopped = False
        
        async def start(self):
            self.started = True
        
        async def stop(self):
            self.stopped = True
    
    service = MockService()
    container.register_singleton("service", service)
    
    # Register lifecycle hooks
    container.on_shutdown("service", lambda s: s.stop())
    
    # Resolve to trigger any startup
    resolved = await container.resolve("service")
    assert resolved is service
    
    # Stop container
    await container.shutdown()
    assert service.stopped


def test_sync_resolve():
    """Test synchronous resolution."""
    container = ServiceContainer()
    
    class MockService:
        value = "test"
    
    service = MockService()
    container.register_singleton("mock", service)
    
    # Sync resolve should work for simple cases
    resolved = container.resolve_sync("mock")
    assert resolved is service
    assert resolved.value == "test"

