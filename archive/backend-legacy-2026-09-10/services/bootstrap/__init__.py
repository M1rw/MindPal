"""
Production-grade unified service bootstrap and composition root.

This package provides the canonical entry point for service initialization.
All services follow the same lifecycle model:
  1. Configuration → 2. Provider setup → 3. Service instantiation → 4. Health validation

Architecture:
- container.py: ServiceContainer dataclass and lifecycle (start/stop)
- composition.py: Main build_service_container orchestrator with dependency ordering
- builders/: Modular builder functions (one per service type)
  - shared_builder.py: Shared dependencies (HTTP client)
  - core_builder.py: Core services (Auth, DB, LLM, TTS)
  - dependent_builder.py: Services depending on LLM
  - infrastructure_builder.py: Quota, rate limits, idempotency
  - specialized_builder.py: Miscellaneous services
  - policy_builder.py: Feature policies and auth
- singleton.py: Global container for non-HTTP contexts

Design principles:
- No service initialization in module scope (lazy, on-demand only)
- All configuration from Settings (no os.getenv)
- All services implement health() contracts
- Explicit lifecycle: start() → operate → stop()
- Request-scoped dependencies injected by Depends()

Usage:

FastAPI Application:
    >>> from backend.services.bootstrap import ServiceContainer, build_service_container
    >>> from fastapi import FastAPI, Depends
    >>> 
    >>> app = FastAPI()
    >>> 
    >>> @app.on_event("startup")
    >>> async def startup():
    ...     container = build_service_container()
    ...     app.state.service_container = container
    >>> 
    >>> @app.get("/chat")
    >>> async def chat(services = Depends(get_services)):
    ...     return await services.llm.generate(prompt)

CLI Script:
    >>> from backend.services.bootstrap import get_global_container
    >>> 
    >>> container = await get_global_container()
    >>> response = await container.llm.generate(prompt)
    >>> await close_global_container()

Testing:
    >>> from backend.services.bootstrap import ServiceContainer
    >>> 
    >>> mock_container = ServiceContainer(
    ...     settings=test_settings,
    ...     auth=mock_auth_service,
    ...     # ... etc
    ... )
    >>> await mock_container.start()
"""

from backend.core.config import Settings, get_settings
from backend.services.domain.auth import AuthService as DomainAuthService
from backend.services.domain.auth import FirebaseAuthProvider, OfflineAuthProvider
from backend.services.domain.storage import StorageService as DomainStorageService

from .composition import build_service_container
from .container import ServiceContainer
from .singleton import (
    close_global_container,
    get_global_container,
    reset_global_container,
)


async def bootstrap_services(
    *,
    settings: Settings | None = None,
    container: ServiceContainer | None = None,
    offline_mode: bool = False,
) -> ServiceContainer:
    """Compatibility async bootstrap entry point."""
    settings = settings or get_settings()
    container = container or build_service_container(settings)

    if offline_mode:
        auth_provider = OfflineAuthProvider()
    else:
        auth_provider = FirebaseAuthProvider(settings=settings)
        if not auth_provider.is_configured:
            auth_provider = OfflineAuthProvider()

    auth_service = DomainAuthService(
        provider=auth_provider,
        settings=settings,
        allow_anonymous=True,
    )
    storage_service = DomainStorageService(settings=settings)

    container.register_singleton("auth_service", auth_service)
    container.register_singleton("storage_service", storage_service)
    return container


async def create_app_container(settings: Settings | None = None) -> ServiceContainer:
    """Compatibility async app container entry point."""
    settings = settings or get_settings()
    return await bootstrap_services(
        settings=settings,
        offline_mode=bool(getattr(settings, "OFFLINE_MODE", False)),
    )

__all__ = [
    "ServiceContainer",
    "build_service_container",
    "bootstrap_services",
    "create_app_container",
    "get_global_container",
    "close_global_container",
    "reset_global_container",
]
