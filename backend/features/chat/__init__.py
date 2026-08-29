# backend/features/chat/__init__.py

"""
Chat feature public exports gatekeeper.
"""

from .routes import router
from .schemas import (
    MAX_ASSISTANT_REPLY_CHARS,
    MAX_CHAT_MESSAGE_CHARS,
    MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS,
    MAX_HISTORY_MESSAGES,
    MAX_LLM_MESSAGES,
    MAX_LLM_PROMPT_CHARS,
    MAX_PROVIDER_NAME_CHARS,
    ChatChannel,
    ChatMessage,
    ChatMetadata,
    ChatRequest,
    ChatResponse,
    ChatRole,
    ChatSession,
    ChatStoreRequest,
    LLMMessage,
    LLMRole,
    RagReference,
)
from .service import ChatService
from .stream_routes import router as stream_router
from .store_routes import router as store_router

__all__ = [
    "MAX_ASSISTANT_REPLY_CHARS",
    "MAX_CHAT_MESSAGE_CHARS",
    "MAX_CLIENT_CUSTOM_INSTRUCTIONS_CHARS",
    "MAX_HISTORY_MESSAGES",
    "MAX_LLM_MESSAGES",
    "MAX_LLM_PROMPT_CHARS",
    "MAX_PROVIDER_NAME_CHARS",
    "ChatChannel",
    "ChatMessage",
    "ChatMetadata",
    "ChatRequest",
    "ChatResponse",
    "ChatRole",
    "ChatService",
    "ChatSession",
    "ChatStoreRequest",
    "LLMMessage",
    "LLMRole",
    "RagReference",
    "router",
    "stream_router",
    "store_router",
]
