# api/index.py
"""
Vercel serverless function entrypoint for MindPal backend.

This module is required by Vercel's Python runtime. It imports and exposes
the FastAPI application created in backend/main.py for serverless execution.

Vercel looks for functions in the /api directory by convention.
"""

from __future__ import annotations

from backend.main import app

__all__ = ["app"]
