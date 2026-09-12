# backend/features/tools/chat_search.py

"""
Conversation history search tool for MindPal.
"""

from __future__ import annotations

from typing import Any

from backend.core.security import sanitize_text
from .base import BaseTool, ToolContext, ToolResult


class ChatSearchTool(BaseTool):
    """Searches past conversation sessions and message history."""

    @property
    def name(self) -> str:
        return "search_chat_history"

    @property
    def description(self) -> str:
        return (
            "Search previous chat conversations, transcripts, and voice calls. "
            "Use when the user references earlier discussions or past advice."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "Keywords or topic discussed previously",
                },
                "limit": {
                    "type": "INTEGER",
                    "description": "Maximum number of message snippets to return (1-10, default 5)",
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query") or ""), 200).strip().lower()
        if not query:
            return ToolResult(error="Search query is required")

        # First check in-memory recent chat history
        matches: list[dict[str, str]] = []
        if context.chat_history:
            for msg in context.chat_history:
                content = str(msg.get("content") or "")
                if query in content.lower():
                    matches.append({
                        "role": str(msg.get("role") or "unknown"),
                        "snippet": sanitize_text(content, 300),
                    })

        limit = min(10, max(1, int(args.get("limit") or 5)))
        return ToolResult(data={
            "query": query,
            "results": matches[:limit],
            "total_matches": len(matches),
        })
