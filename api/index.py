"""
Vercel Functions entry point for MindPal API.

This module serves as the serverless function handler that Vercel will invoke.
It exports the FastAPI application configured for the Vercel environment.
"""

from __future__ import annotations

# Configure environment defaults for Vercel serverless deployment.
# These are set defensively — they are overridden if the .env file provides them.
import os
os.environ.setdefault("ENVIRONMENT", "production")
os.environ.setdefault("DEBUG", "false")
os.environ.setdefault("PYTHONUNBUFFERED", "1")

# Import the FastAPI application
from backend.main import app

__all__ = ["app"]

