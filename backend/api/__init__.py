# backend/api/__init__.py

from __future__ import annotations

from fastapi import APIRouter

from .health_router import router as health_router
from .chat_router import router as chat_router
from .user_router import router as user_router
from .memory_router import router as memory_router
from .chat_store_router import router as chat_store_router
from .safety_router import router as safety_router
from .tts_router import router as tts_router
from .chat_stream_router import router as chat_stream_router
from .voice_router import router as voice_router
from .tools_router import router as tools_router


def create_api_router() -> APIRouter:
    api_router = APIRouter()

    api_router.include_router(health_router)
    api_router.include_router(chat_router)
    api_router.include_router(user_router)
    api_router.include_router(memory_router)
    api_router.include_router(chat_store_router)
    api_router.include_router(safety_router)
    api_router.include_router(tts_router)
    api_router.include_router(chat_stream_router)
    api_router.include_router(voice_router)
    api_router.include_router(tools_router)

    return api_router


api_router = create_api_router()


__all__ = [
    "api_router",
    "create_api_router",
]

