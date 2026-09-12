"""Compatibility shim for the canonical service container API.

The authoritative container now lives at backend.services.bootstrap.container.
This module remains as a thin adapter so old imports keep working while the
repository converges to one bootstrap and lifecycle definition.
"""

from backend.services.bootstrap.container import ServiceContainer, ServiceNotFoundError

__all__ = ["ServiceContainer", "ServiceNotFoundError"]
