# backend/features/tools/web_search.py

"""
DuckDuckGo-based web search tool for real-time information retrieval.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

import httpx

from backend.core.security import sanitize_text
from .base import BaseTool, ToolContext, ToolResult
from .web_search_parsers import ddg_html_search, ddg_instant_answer, ddg_lite_search

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 200
MAX_RESULTS = 5
REQUEST_TIMEOUT = 6.0
_RATE_LIMIT_KEY = "_web_search_count"
_MAX_SEARCHES_PER_REQUEST = 3


class WebSearchTool(BaseTool):
    """Search the web for real-time information using DuckDuckGo."""

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return (
            "Search the web for real-time, current information. Use this when the user "
            "asks about current events, recent news, changing facts, weather, or live data."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "The search query — specific and concise",
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query", "")), MAX_QUERY_CHARS).strip()
        if not query:
            return ToolResult(error="Search query is required")

        search_count = context.metadata.get(_RATE_LIMIT_KEY, 0)
        if search_count >= _MAX_SEARCHES_PER_REQUEST:
            return ToolResult(
                error=f"Search limit reached ({_MAX_SEARCHES_PER_REQUEST} per request)",
                data={"query": query},
            )
        context.metadata[_RATE_LIMIT_KEY] = search_count + 1

        try:
            shared_client = getattr(getattr(context, "services", None), "http_client", None)
            results = await _search_cascade(query, client=shared_client)
            if not results:
                return ToolResult(data={
                    "query": query,
                    "results": [],
                    "note": "No results found. Try rephrasing the query.",
                })
            return ToolResult(data={
                "query": query,
                "results": results[:MAX_RESULTS],
                "result_count": len(results),
            })
        except asyncio.TimeoutError:
            return ToolResult(error="Search timed out. Try again with a shorter query.", data={"query": query})
        except Exception as exc:
            logger.warning("Web search failed: %s", type(exc).__name__)
            return ToolResult(error="Search temporarily unavailable. Please try again.", data={"query": query})


async def _search_cascade(query: str, *, client: httpx.AsyncClient | None = None) -> list[dict[str, str]]:
    owns_client = client is None
    active_client = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True)

    try:
        try:
            html_res = await ddg_html_search(active_client, query)
            if html_res:
                return html_res
        except Exception:
            pass

        try:
            instant_res = await ddg_instant_answer(active_client, query)
            if instant_res:
                return instant_res
        except Exception:
            pass

        try:
            lite_res = await ddg_lite_search(active_client, query)
            if lite_res:
                return lite_res
        except Exception:
            pass
    finally:
        if owns_client:
            await active_client.aclose()

    return []
