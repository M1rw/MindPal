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

from .composition import build_service_container
from .container import ServiceContainer
from .singleton import (
    close_global_container,
    get_global_container,
    reset_global_container,
)

__all__ = [
    "ServiceContainer",
    "build_service_container",
    "get_global_container",
    "close_global_container",
    "reset_global_container",
]
