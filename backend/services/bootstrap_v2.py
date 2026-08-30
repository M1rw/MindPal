"""Backward-compatible shim for the modular bootstrap package.

This module preserves the historical `backend.services.bootstrap_v2` import path
used by existing contract tests and legacy callers while delegating to the new
canonical bootstrap package.
"""

from __future__ import annotations

from backend.services.bootstrap import ServiceContainer, build_service_container

__all__ = ["ServiceContainer", "build_service_container"]
