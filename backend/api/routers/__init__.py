# backend/api/routers/__init__.py

"""
FastAPI domain endpoint routers package.
"""

from __future__ import annotations

from .brain import router as brain_router
from .chat import router as chat_router
from .chat_store import router as chat_store_router
from .chat_stream import router as chat_stream_router
from .favicon import router as favicon_router
from .feature import admin_router as feature_admin_router
from .feature import router as feature_router
from .health import router as health_router
from .memory import router as memory_router
from .notifications import router as notifications_router
from .safety import router as safety_router
from .tools import router as tools_router
from .tts import router as tts_router
from .user import router as user_router
from .voice_v4 import router as voice_v4_router

__all__ = [
    "brain_router",
    "chat_router",
    "chat_store_router",
    "chat_stream_router",
    "favicon_router",
    "feature_admin_router",
    "feature_router",
    "health_router",
    "memory_router",
    "notifications_router",
    "safety_router",
    "tools_router",
    "tts_router",
    "user_router",
    "voice_v4_router",
]
