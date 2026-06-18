# backend/tools/memory_search_tool.py

"""
Memory search tools for MindPal.

Server-side replacement for the frontend-only search_memory and get_user_profile
tools that were in voice_session.js. These access real Firestore data instead of
just frontend localStorage.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.core.security import sanitize_text
from backend.models.memory import MemoryGraph
from backend.tools import BaseTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 200
MAX_RESULTS = 20
MAX_FACT_CHARS = 400


class MemorySearchTool(BaseTool):
    """
    Search the user's saved memory graph for personal facts, relationships,
    preferences, patterns, coping tools, and past context.

    Migrated from: frontend/js/voice_session.js → search_memory
    """

    @property
    def name(self) -> str:
        return "search_memory"

    @property
    def description(self) -> str:
        return (
            "Search the user's saved memory for personal facts, relationships, "
            "important people (like girlfriend, family), preferences, emotional triggers, "
            "goals, coping tools, and past context. Use this when the user asks about "
            "something you should remember, or to personalize your response."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": (
                        "What to search for — e.g. 'girlfriend', 'triggers', "
                        "'goals', 'preferences', 'name', 'coping skills'"
                    ),
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query", "")), MAX_QUERY_CHARS).lower()

        if not context.services or not context.authenticated:
            return ToolResult(data={"facts": [], "query": query, "note": "No memory available for anonymous users"})

        try:
            db = context.services.db
            graph_result = await db.load_memory_graph(context.user_id_hash)

            if not graph_result.loaded or not graph_result.graph:
                # Try legacy memory
                memory_result = await db.load_memory(context.user_id_hash)
                if memory_result.summary:
                    return _search_summary(memory_result.summary, query)
                return ToolResult(data={"facts": [], "query": query, "note": "No memory saved yet"})

            return _search_graph(graph_result.graph, query)

        except Exception as exc:
            logger.debug("Memory search failed: %s", type(exc).__name__)
            return ToolResult(data={"facts": [], "query": query, "note": "Memory search temporarily unavailable"})


class GetUserProfileTool(BaseTool):
    """
    Get the current user's profile including name, preferences, and communication style.

    Migrated from: frontend/js/voice_session.js → get_user_profile
    """

    @property
    def name(self) -> str:
        return "get_user_profile"

    @property
    def description(self) -> str:
        return (
            "Get the current user's profile including their name, communication preferences, "
            "tone, language, and response style preferences. Call this when you need to know "
            "who you're talking to or how they prefer to be spoken to."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "OBJECT", "properties": {}}

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        if not context.services or not context.authenticated:
            return ToolResult(data={
                "name": "unknown",
                "preferences": {},
                "note": "Profile not available for anonymous users",
            })

        try:
            db = context.services.db
            profile_result = await db.load_user_profile(context.user_id_hash)
            profile = profile_result.profile
            prefs = profile.preferences

            return ToolResult(data={
                "name": prefs.preferred_name or "unknown",
                "preferred_name": prefs.preferred_name or "",
                "communication_style": prefs.communication_style.value if prefs.communication_style else "balanced",
                "custom_instructions": prefs.custom_instructions or "",
                "wellness_goals": list(prefs.wellness_goals or []),
                "preferred_coping_tools": list(prefs.preferred_coping_tools or []),
                "avoided_topics": list(prefs.avoided_topics or []),
            })

        except Exception as exc:
            logger.debug("Profile load failed: %s", type(exc).__name__)
            return ToolResult(data={"name": "unknown", "preferences": {}, "note": "Profile temporarily unavailable"})


def _search_graph(graph: MemoryGraph, query: str) -> ToolResult:
    """Search memory graph atoms by keyword matching."""
    all_facts: list[str] = []
    matching: list[str] = []

    for atom in graph.atoms:
        fact_text = sanitize_text(str(getattr(atom, "content", "") or getattr(atom, "value", "") or str(atom)), MAX_FACT_CHARS)
        if not fact_text:
            continue
        all_facts.append(fact_text)
        if query and query.lower() in fact_text.lower():
            matching.append(fact_text)

    if not query:
        return ToolResult(data={
            "facts": all_facts[:MAX_RESULTS],
            "query": "",
            "total_memories": len(all_facts),
        })

    return ToolResult(data={
        "query": query,
        "facts": matching[:MAX_RESULTS] if matching else all_facts[:10],
        "match_count": len(matching),
        "total_memories": len(all_facts),
        "note": "" if matching else f"No exact matches for '{query}', showing recent memories instead",
    })


def _search_summary(summary: Any, query: str) -> ToolResult:
    """Search legacy MemorySummary format."""
    facts: list[str] = []

    # Extract all text fields from summary
    for attr_name in ("learned_facts", "facts", "topics", "preferences", "coping_tools", "goals"):
        values = getattr(summary, attr_name, None)
        if isinstance(values, (list, tuple)):
            for v in values:
                fact_text = sanitize_text(str(v), MAX_FACT_CHARS)
                if fact_text:
                    facts.append(fact_text)
        elif isinstance(values, str) and values:
            facts.append(sanitize_text(values, MAX_FACT_CHARS))

    if not query:
        return ToolResult(data={"facts": facts[:MAX_RESULTS], "query": ""})

    matching = [f for f in facts if query.lower() in f.lower()]
    return ToolResult(data={
        "query": query,
        "facts": matching[:MAX_RESULTS] if matching else facts[:10],
        "match_count": len(matching),
    })
