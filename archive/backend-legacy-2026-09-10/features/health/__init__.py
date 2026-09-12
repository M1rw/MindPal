# backend/features/health/__init__.py

"""
Health and readiness feature public exports.
"""

from .routes import router
from .service import HealthService

__all__ = ["router", "HealthService"]
