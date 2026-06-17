# backend/tools/web_search_tool.py

"""
Custom web search tool for MindPal.

Uses DuckDuckGo's public API (free, no API key needed) for real-time
web search. No dependency on paid search APIs like Tavily or SerpAPI.

Architecture:
- Primary: DuckDuckGo Instant Answer API (JSON, fast, reliable)
- Fallback: DuckDuckGo HTML search with response parsing
- Rate-limited: max 3 searches per chat request
- Results are sanitized and stripped of tracking URLs
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from typing import Any
from urllib.parse import quote_plus, unquote

import httpx

from backend.core.security import sanitize_text
from backend.tools import BaseTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

MAX_QUERY_CHARS = 200
MAX_SNIPPET_CHARS = 500
MAX_RESULTS = 5
REQUEST_TIMEOUT = 10.0

# Rate limit tracking (per-request via context metadata)
_RATE_LIMIT_KEY = "_web_search_count"
_MAX_SEARCHES_PER_REQUEST = 3


class WebSearchTool(BaseTool):
    """
    Search the web for real-time information using DuckDuckGo.

    No paid API key required. Results include title, snippet, and source URL.
    Rate-limited to prevent abuse.
    """

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return (
            "Search the web for real-time, current information. Use this when the user "
            "asks about current events, recent news, facts you're unsure about, weather, "
            "or anything that requires up-to-date data. Returns titles, snippets, and URLs."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "The search query — be specific and concise",
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        query = sanitize_text(str(args.get("query", "")), MAX_QUERY_CHARS).strip()

        if not query:
            return ToolResult(error="Search query is required")

        # Rate limit check
        search_count = context.metadata.get(_RATE_LIMIT_KEY, 0)
        if search_count >= _MAX_SEARCHES_PER_REQUEST:
            return ToolResult(
                error=f"Search limit reached ({_MAX_SEARCHES_PER_REQUEST} per request)",
                data={"query": query},
            )
        context.metadata[_RATE_LIMIT_KEY] = search_count + 1

        try:
            results = await _search_duckduckgo(query)

            if not results:
                return ToolResult(data={
                    "query": query,
                    "results": [],
                    "note": "No results found. Try a different query.",
                })

            return ToolResult(data={
                "query": query,
                "results": results[:MAX_RESULTS],
                "result_count": len(results),
            })

        except asyncio.TimeoutError:
            return ToolResult(
                error="Search timed out. Try again.",
                data={"query": query},
            )
        except Exception as exc:
            logger.debug("Web search failed: %s", type(exc).__name__)
            return ToolResult(
                error="Search temporarily unavailable",
                data={"query": query},
            )


async def _search_duckduckgo(query: str) -> list[dict[str, str]]:
    """
    Search DuckDuckGo using two strategies:
    1. Instant Answer API (structured JSON, fast)
    2. HTML search page parsing (more results, slower)
    """
    results: list[dict[str, str]] = []

    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        headers={
            "User-Agent": "MindPal/1.0 (Mental Wellness Companion)",
            "Accept": "application/json, text/html",
            "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
        },
    ) as client:
        # Strategy 1: DuckDuckGo Instant Answer API
        instant_results = await _ddg_instant_answer(client, query)
        results.extend(instant_results)

        # Strategy 2: DuckDuckGo HTML search (if instant answer didn't give enough)
        if len(results) < 3:
            html_results = await _ddg_html_search(client, query)
            # Add HTML results that aren't duplicates
            seen_urls = {r.get("url", "") for r in results}
            for r in html_results:
                if r.get("url", "") not in seen_urls:
                    results.append(r)
                    seen_urls.add(r.get("url", ""))

    return results[:MAX_RESULTS]


async def _ddg_instant_answer(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    """Query DuckDuckGo Instant Answer API."""
    results: list[dict[str, str]] = []

    try:
        url = f"https://api.duckduckgo.com/?q={quote_plus(query)}&format=json&no_html=1&skip_disambig=1"
        response = await client.get(url)

        if response.status_code != 200:
            return results

        data = response.json()

        # Abstract (main instant answer)
        abstract_text = str(data.get("AbstractText", "")).strip()
        abstract_url = str(data.get("AbstractURL", "")).strip()
        abstract_source = str(data.get("AbstractSource", "")).strip()

        if abstract_text and abstract_url:
            results.append({
                "title": abstract_source or "DuckDuckGo",
                "snippet": sanitize_text(abstract_text, MAX_SNIPPET_CHARS),
                "url": _clean_url(abstract_url),
                "source": abstract_source,
            })

        # Answer (direct factual answer)
        answer = str(data.get("Answer", "")).strip()
        if answer:
            results.append({
                "title": "Direct Answer",
                "snippet": sanitize_text(answer, MAX_SNIPPET_CHARS),
                "url": "",
                "source": "DuckDuckGo",
            })

        # Related topics
        related_topics = data.get("RelatedTopics", [])
        for topic in related_topics[:5]:
            if not isinstance(topic, dict):
                continue

            text = str(topic.get("Text", "")).strip()
            first_url = str(topic.get("FirstURL", "")).strip()

            if text and first_url:
                results.append({
                    "title": _extract_title_from_text(text),
                    "snippet": sanitize_text(text, MAX_SNIPPET_CHARS),
                    "url": _clean_url(first_url),
                    "source": "DuckDuckGo",
                })

    except Exception:
        pass  # Silently fall through to HTML search

    return results


async def _ddg_html_search(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    """Parse DuckDuckGo HTML search results as fallback."""
    results: list[dict[str, str]] = []

    try:
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        response = await client.get(url)

        if response.status_code != 200:
            return results

        body = response.text

        # Parse result blocks: <a class="result__a" href="...">title</a>
        # and <a class="result__snippet" href="...">snippet</a>
        link_pattern = re.compile(
            r'<a\s+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
            re.DOTALL | re.IGNORECASE,
        )
        snippet_pattern = re.compile(
            r'<a\s+class="result__snippet"[^>]*>(.*?)</a>',
            re.DOTALL | re.IGNORECASE,
        )

        links = link_pattern.findall(body)
        snippets = snippet_pattern.findall(body)

        for i, (raw_url, raw_title) in enumerate(links[:MAX_RESULTS]):
            title = _strip_html(raw_title).strip()
            snippet = _strip_html(snippets[i]).strip() if i < len(snippets) else ""
            clean = _clean_ddg_redirect(raw_url)

            if title and clean:
                results.append({
                    "title": sanitize_text(title, 200),
                    "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
                    "url": clean,
                    "source": _extract_domain(clean),
                })

    except Exception:
        pass

    return results


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    cleaned = re.sub(r"<[^>]+>", "", text)
    return html.unescape(cleaned)


def _clean_url(url: str) -> str:
    """Strip tracking parameters from URLs."""
    cleaned = url.split("?utm_")[0]
    cleaned = cleaned.split("&utm_")[0]
    return cleaned.strip()


def _clean_ddg_redirect(url: str) -> str:
    """Resolve DuckDuckGo redirect URLs to actual destination."""
    if "duckduckgo.com" in url and "uddg=" in url:
        match = re.search(r"uddg=([^&]+)", url)
        if match:
            return unquote(match.group(1))
    return _clean_url(url)


def _extract_domain(url: str) -> str:
    """Extract domain from URL for source attribution."""
    match = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return match.group(1) if match else ""


def _extract_title_from_text(text: str) -> str:
    """Extract a title from DuckDuckGo topic text (first sentence or phrase)."""
    # DDG topic text often starts with the title in bold or before a dash
    for sep in (" - ", " — ", ": ", ". "):
        if sep in text:
            return sanitize_text(text.split(sep)[0], 100)
    return sanitize_text(text[:80], 100)
