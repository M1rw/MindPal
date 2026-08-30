"""Compatibility shim for the canonical backend service bootstrap.

The authoritative implementation now lives under backend.services.bootstrap.
This file intentionally delegates to that single source of truth so the codebase
has one place to construct the application service container.
"""

from __future__ import annotations

from backend.services.bootstrap import (  # noqa: F401
    ServiceContainer,
    build_service_container,
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

