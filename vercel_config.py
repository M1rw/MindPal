"""
Vercel deployment configuration and initialization.

This module ensures proper Vercel serverless function configuration
and handles FastAPI app initialization for serverless environments.
"""

from __future__ import annotations

import os
from pathlib import Path


def configure_vercel_environment() -> None:
    """
    Configure environment for Vercel deployment.
    
    - Sets sensible defaults for serverless environment
    - Ensures proper static file serving paths
    - Configures logging for Vercel platform
    """
    # Ensure production-like settings
    os.environ.setdefault("ENVIRONMENT", "production")
    os.environ.setdefault("DEBUG", "false")
    os.environ.setdefault("ENABLE_DOCS", "false")
    os.environ.setdefault("ENABLE_HSTS", "true")
    
    # Python-specific optimizations for serverless
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    os.environ.setdefault("PYTHONHASHSEED", "0")
    
    # Frontend path configuration for static asset serving
    project_root = Path(__file__).parent
    frontend_dir = project_root / "frontend"
    if frontend_dir.exists():
        os.environ.setdefault("FRONTEND_DIR", str(frontend_dir))


def get_vercel_app():
    """
    Get FastAPI application instance configured for Vercel.
    
    This is the entry point for Vercel Functions.
    """
    configure_vercel_environment()
    
    from backend.main import app as fastapi_app
    return fastapi_app


# Initialize on import for Vercel Functions
configure_vercel_environment()
