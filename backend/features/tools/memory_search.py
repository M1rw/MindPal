# backend/features/tools/memory_search.py

"""
Semantic memory search tool for MindPal.
"""

from __future__ import annotations

from typing import Any

from backend.core.security import sanitize_text
from .base import BaseTool, ToolContext, ToolResult


class MemorySearchTool(BaseTool):
    """Searches user's long-term memory graph and compacted summaries."""

    @property
    def name(self) -> str:
        return "search_memory"

    @property
    def description(self) -> str:
        return (
            "Search the user's stored personal memories, facts, preferences, and coping patterns. "
            "Use when the user asks 'do you remember...', mentions past shared topics, or needs context."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "Topic, person, emotion, or keyword to search for in memory",
                },
                "category": {
                    "type": "STRING",
                    "description": "Optional category filter: relationship, work, habit, trigger, preference",
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query") or ""), 200).strip()
        category = sanitize_text(str(args.get("category") or ""), 50).strip()

        if not query:
            return ToolResult(error="Search query is required")

        if not context.user_id_hash:
            return ToolResult(data={"query": query, "results": [], "note": "No active user session context."})

        services = context.services
        if not services or not hasattr(services, "memory"):
            return ToolResult(data={"query": query, "results": [], "note": "Memory subsystem not loaded."})

        try:
            results = await services.memory.search(
                user_id=context.user_id_hash,
                query=query,
                category=category or None,
            )
            return ToolResult(data={"query": query, "results": results, "count": len(results)})
        except Exception as exc:
            return ToolResult(error=f"Memory search failed: {type(exc).__name__}")
