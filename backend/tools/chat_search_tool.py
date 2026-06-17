# backend/tools/chat_search_tool.py

"""
Chat history search tools for MindPal.

Server-side replacement for the frontend-only get_recent_chat and
search_chat_history tools that were in voice_session.js. These access
Firestore chat snapshots instead of just frontend localStorage.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.core.security import sanitize_text
from backend.tools import BaseTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 200
MAX_MESSAGE_TEXT_CHARS = 400
MAX_RESULTS = 20


class GetRecentChatTool(BaseTool):
    """
    Get the most recent text chat messages.

    Migrated from: frontend/js/voice_session.js → get_recent_chat
    """

    @property
    def name(self) -> str:
        return "get_recent_chat"

    @property
    def description(self) -> str:
        return (
            "Get the most recent text chat messages between the user and MindPal. "
            "Use this to understand what they were just talking about before starting "
            "the voice call, or to continue a previous conversation."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "count": {
                    "type": "INTEGER",
                    "description": "Number of recent messages to get (default 10, max 20)",
                },
            },
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        count = min(max(1, int(args.get("count", 10) or 10)), MAX_RESULTS)

        # First try: use chat_history from the request context (fastest path)
        if context.chat_history:
            messages = context.chat_history[-count:]
            return ToolResult(data={
                "messages": [
                    {
                        "from": _normalize_role(m.get("role", "")),
                        "text": sanitize_text(str(m.get("content", m.get("text", ""))), MAX_MESSAGE_TEXT_CHARS),
                    }
                    for m in messages
                ],
                "count": len(messages),
                "source": "request_context",
            })

        # Second try: load from Firestore (for voice sessions that don't pass history)
        if context.services and context.authenticated:
            try:
                db = context.services.db
                snapshot_result = await db.get_document(
                    "chat_snapshots",
                    context.user_id_hash,
                )
                if snapshot_result and isinstance(snapshot_result, dict):
                    raw_messages = snapshot_result.get("messages", [])
                    if isinstance(raw_messages, list):
                        messages = raw_messages[-count:]
                        return ToolResult(data={
                            "messages": [
                                {
                                    "from": _normalize_role(m.get("role", "")),
                                    "text": sanitize_text(
                                        str(m.get("content", m.get("text", ""))),
                                        MAX_MESSAGE_TEXT_CHARS,
                                    ),
                                }
                                for m in messages
                                if isinstance(m, dict)
                            ],
                            "count": len(messages),
                            "source": "firestore",
                        })
            except Exception as exc:
                logger.debug("Chat snapshot load failed: %s", type(exc).__name__)

        return ToolResult(data={
            "messages": [],
            "count": 0,
            "note": "No chat history available",
        })


class SearchChatHistoryTool(BaseTool):
    """
    Search through chat history for messages matching a query.

    Migrated from: frontend/js/voice_session.js → search_chat_history
    """

    @property
    def name(self) -> str:
        return "search_chat_history"

    @property
    def description(self) -> str:
        return (
            "Search through the user's full chat history for messages matching a specific "
            "topic or keyword. Use this when the user references a past conversation."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "Text or topic to search for in past messages",
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query", "")), MAX_QUERY_CHARS).lower()

        if not query:
            return ToolResult(data={"results": [], "query": "", "total_matches": 0})

        # Search in-request chat history first
        all_messages: list[dict[str, str]] = []

        if context.chat_history:
            all_messages = [
                {
                    "from": _normalize_role(m.get("role", "")),
                    "text": str(m.get("content", m.get("text", ""))),
                }
                for m in context.chat_history
            ]

        # Also try Firestore
        if context.services and context.authenticated:
            try:
                db = context.services.db
                snapshot_result = await db.get_document(
                    "chat_snapshots",
                    context.user_id_hash,
                )
                if snapshot_result and isinstance(snapshot_result, dict):
                    raw_messages = snapshot_result.get("messages", [])
                    if isinstance(raw_messages, list):
                        for m in raw_messages:
                            if isinstance(m, dict):
                                msg = {
                                    "from": _normalize_role(m.get("role", "")),
                                    "text": str(m.get("content", m.get("text", ""))),
                                }
                                # Avoid duplicates (same text from request context and firestore)
                                if msg not in all_messages:
                                    all_messages.append(msg)
            except Exception as exc:
                logger.debug("Chat search from Firestore failed: %s", type(exc).__name__)

        # Filter by query
        matching = [
            {
                "from": m["from"],
                "text": sanitize_text(m["text"], MAX_MESSAGE_TEXT_CHARS),
            }
            for m in all_messages
            if query in m["text"].lower()
        ]

        return ToolResult(data={
            "query": query,
            "results": matching[:MAX_RESULTS],
            "total_matches": len(matching),
        })


def _normalize_role(role: str) -> str:
    """Normalize role to 'user' or 'mindpal'."""
    raw = str(role or "").lower().strip()
    if raw in {"user", "human"}:
        return "user"
    return "mindpal"
