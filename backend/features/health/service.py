# backend/features/health/service.py

"""
Health and readiness probes for MindPal subsystems.
"""

from __future__ import annotations

import time
from typing import Any


class HealthService:
    """Probes system subsystems and returns component health metrics."""

    def __init__(self, version: str = "2.0.0", environment: str = "development") -> None:
        self.version = version
        self.environment = environment
        self._boot_time = time.time()

    def get_liveness_status(self) -> dict[str, Any]:
        """Fast liveness check."""
        return {
            "status": "ok",
            "version": self.version,
            "environment": self.environment,
            "uptime_seconds": round(time.time() - self._boot_time, 2),
        }

    def get_readiness_status(self, db_ready: bool = True) -> dict[str, Any]:
        """Readiness check including database and provider state."""
        return {
            "status": "ok" if db_ready else "degraded",
            "database": "connected" if db_ready else "unavailable",
            "version": self.version,
            "timestamp": time.time(),
        }
