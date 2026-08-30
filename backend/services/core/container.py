# Service Container for Dependency Injection

from typing import Any, Callable, Dict, Optional, TypeVar
from functools import lru_cache
import asyncio
import logging

logger = logging.getLogger(__name__)

T = TypeVar('T')


class ServiceContainer:
    """
    Lightweight async-first DI container for production microservices.
    
    Features:
    - Lazy singleton initialization
    - Thread-safe resolution
    - Support for async factory functions
    - Service lifecycle management
    """
    
    def __init__(self) -> None:
        self._singletons: Dict[str, Any] = {}
        self._factories: Dict[str, Callable[..., Any]] = {}
        self._lifecycle_hooks: Dict[str, list[Callable]] = {}
        self._lock = asyncio.Lock()
        self._initialized = False
    
    def register_singleton(
        self,
        key: str,
        factory: Callable[..., Any],
        on_shutdown: Optional[Callable] = None
    ) -> None:
        """
        Register a singleton service.
        
        Args:
            key: Service identifier
            factory: Sync or async factory function
            on_shutdown: Optional cleanup function
        """
        if key in self._singletons or key in self._factories:
            logger.warning(f"Service '{key}' already registered, overwriting")
        
        self._factories[key] = factory
        
        if on_shutdown:
            if key not in self._lifecycle_hooks:
                self._lifecycle_hooks[key] = []
            self._lifecycle_hooks[key].append(on_shutdown)
    
    async def resolve(self, key: str) -> Any:
        """
        Resolve a service (async-safe, handles both sync and async factories).
        
        Args:
            key: Service identifier
            
        Returns:
            Service instance
            
        Raises:
            ValueError: If service not registered
        """
        if key in self._singletons:
            return self._singletons[key]
        
        if key not in self._factories:
            raise ValueError(f"Service '{key}' not registered in container")
        
        async with self._lock:
            # Double-check locking pattern for thread safety
            if key in self._singletons:
                return self._singletons[key]
            
            logger.debug(f"Resolving service: {key}")
            factory = self._factories[key]
            
            try:
                # Support both async and sync factories
                if asyncio.iscoroutinefunction(factory):
                    instance = await factory()
                else:
                    instance = factory()
                
                self._singletons[key] = instance
                logger.debug(f"Service resolved: {key}")
                return instance
            except Exception as e:
                logger.error(f"Failed to resolve service '{key}': {e}")
                raise
    
    def resolve_sync(self, key: str) -> Any:
        """
        Synchronous resolution (for startup/testing only).
        Note: Does not work with async factories.
        
        Args:
            key: Service identifier
            
        Returns:
            Service instance
        """
        if key in self._singletons:
            return self._singletons[key]
        
        if key not in self._factories:
            raise ValueError(f"Service '{key}' not registered in container")
        
        factory = self._factories[key]
        
        if asyncio.iscoroutinefunction(factory):
            raise RuntimeError(
                f"Cannot resolve async service '{key}' synchronously. "
                "Use async resolve() instead."
            )
        
        instance = factory()
        self._singletons[key] = instance
        return instance
    
    async def shutdown(self) -> None:
        """
        Gracefully shutdown all services.
        Calls registered on_shutdown hooks.
        """
        logger.info("Shutting down service container...")
        
        for key in list(self._singletons.keys()):
            if key in self._lifecycle_hooks:
                for hook in self._lifecycle_hooks[key]:
                    try:
                        if asyncio.iscoroutinefunction(hook):
                            await hook()
                        else:
                            hook()
                    except Exception as e:
                        logger.error(f"Error in shutdown hook for {key}: {e}")
        
        self._singletons.clear()
        self._factories.clear()
        logger.info("Service container shutdown complete")


@lru_cache(maxsize=1)
def get_global_container() -> ServiceContainer:
    """
    Get or create the global service container.
    Uses LRU cache to ensure singleton pattern.
    """
    return ServiceContainer()


def reset_container() -> None:
    """Reset global container (for testing)."""
    get_global_container.cache_clear()

