# backend/api/__init__.py

"""
MindPal presentation layer (FastAPI routers, schemas, dependencies, and exception handlers).
"""

from __future__ import annotations

from fastapi import APIRouter

from .errors import map_domain_error_to_http
from .routers import (
    brain_router,
    chat_router,
    chat_store_router,
    chat_stream_router,
    favicon_router,
    feature_admin_router,
    feature_router,
    health_router,
    memory_router,
    safety_router,
    tools_router,
    tts_router,
    user_router,
    voice_v4_router,
)


def create_api_router() -> APIRouter:
    api_router = APIRouter()

    api_router.include_router(health_router)
    api_router.include_router(chat_router)
    api_router.include_router(user_router)
    api_router.include_router(memory_router)
    api_router.include_router(brain_router)
    api_router.include_router(chat_store_router)
    api_router.include_router(safety_router)
    api_router.include_router(tts_router)
    api_router.include_router(chat_stream_router)
    api_router.include_router(tools_router)
    api_router.include_router(favicon_router)
    api_router.include_router(feature_router)
    api_router.include_router(feature_admin_router)
    api_router.include_router(voice_v4_router)

    return api_router


api_router = create_api_router()


__all__ = [
    "api_router",
    "create_api_router",
    "map_domain_error_to_http",
]
