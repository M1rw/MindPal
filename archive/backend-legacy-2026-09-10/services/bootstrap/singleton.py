"""
Global singleton container management.

For CLI scripts, background tasks, and non-HTTP contexts, services
need a global container instance. This module provides thread-safe
singleton management via asyncio.Lock.

Note: For FastAPI applications, prefer request-scoped containers
via Depends() and app.state rather than this global pattern.
"""

import asyncio
import logging

from backend.core.config import Settings, get_settings

from .composition import build_service_container
from .container import ServiceContainer

logger = logging.getLogger(__name__)

_global_container: ServiceContainer | None = None
_container_lock = asyncio.Lock()


async def get_global_container(settings: Settings | None = None) -> ServiceContainer:
    """
    Get or create the global service container singleton.

    Used for:
    - CLI scripts
    - Background tasks
    - Non-HTTP contexts

    For FastAPI applications, prefer request-scoped containers via Depends().

    Args:
        settings: Application settings (only used on first call)

    Returns:
        Global ServiceContainer instance

    Example:
        >>> container = await get_global_container()
        >>> response = await container.llm.generate(prompt)
    """
    global _global_container

    if _global_container is not None:
        return _global_container

    async with _container_lock:
        if _global_container is not None:
            return _global_container

        _global_container = build_service_container(settings or get_settings())
        await _global_container.start()
        return _global_container


async def close_global_container() -> None:
    """Close the global service container singleton."""
    global _global_container

    if _global_container is None:
        return

    await _global_container.stop()
    _global_container = None


def reset_global_container() -> None:
    """Reset global container for testing."""
    global _global_container
    _global_container = None
