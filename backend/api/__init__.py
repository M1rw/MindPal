# backend/api/__init__.py

"""
MindPal API router package.

This package exposes all FastAPI routers and the aggregate API router used by
backend/main.py.

Importing this package must not:
- call LLM providers
- connect to Firebase
- run safety classification
- read/write database state
- perform TTS synthesis
"""

from __future__ import annotations

from fastapi import APIRouter

from .chat_router import router as chat_router
from .health_router import router as health_router
from .memory_router import router as memory_router
from .tts_router import router as tts_router
from .user_router import router as user_router
from .safety_router import router as safety_router


def create_api_router() -> APIRouter:
    """
    Build the aggregate API router.

    Individual routers already define their own prefixes:
    - /api/chat
    - /api/memory/*
    - /api/user/*
    - /api/health/*
    - /api/tts/*
    - /api/safety/*
    """
    api_router = APIRouter()

    api_router.include_router(health_router)
    api_router.include_router(chat_router)
    api_router.include_router(memory_router)
    api_router.include_router(user_router)
    api_router.include_router(tts_router)
    api_router.include_router(safety_router)
    return api_router


api_router = create_api_router()


__all__ = [
    "api_router",
    "chat_router",
    "create_api_router",
    "health_router",
    "memory_router",
    "tts_router",
    "user_router",
    "safety_router",
]