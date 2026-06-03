"""
Vercel Functions entry point for MindPal API.

This module serves as the serverless function handler that Vercel will invoke.
It exports the FastAPI application configured for the Vercel environment.
"""

from __future__ import annotations

try:
    # Import and configure for Vercel environment
    from vercel_config import configure_vercel_environment
    
    configure_vercel_environment()
    
except ImportError:
    # Fallback: configure directly if vercel_config unavailable
    import os
    os.environ.setdefault("ENVIRONMENT", "production")
    os.environ.setdefault("DEBUG", "false")
    os.environ.setdefault("PYTHONUNBUFFERED", "1")

# Import the FastAPI application
from backend.main import app

__all__ = ["app"]
