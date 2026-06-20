# backend/tools/web_search_tool.py

"""
Web search tool for MindPal — Multi-provider with cascading fallbacks.

Search Cascade (in order):
1. Brave Search API (free tier, 2000 queries/month) — if BRAVE_SEARCH_API_KEY is set
2. DuckDuckGo Lite (more reliable from datacenter IPs than main DDG)
3. DuckDuckGo Instant Answer API (structured JSON)
4. DuckDuckGo HTML search (last resort)

All providers are free. DuckDuckGo often blocks datacenter IPs (Vercel, AWS, etc.)
so Brave Search is the recommended primary provider for production deployments.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
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
REQUEST_TIMEOUT = 5.0

# Rate limit tracking (per-request via context metadata)
_RATE_LIMIT_KEY = "_web_search_count"
_MAX_SEARCHES_PER_REQUEST = 3

# Optional Brave Search API key (free tier: 2000 queries/month)
# Set via environment variable BRAVE_SEARCH_API_KEY
BRAVE_SEARCH_API_KEY = os.environ.get("BRAVE_SEARCH_API_KEY", "")


class WebSearchTool(BaseTool):
    """
    Search the web for real-time information.

    Uses Brave Search API (if configured) with DuckDuckGo fallback.
    No paid API key required for DuckDuckGo, but Brave is recommended
    for reliable results from serverless/datacenter environments.
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
            results = await _search_cascade(query)

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


# ═══════════════════════════════════════════════════════════════
# Search cascade — try providers in order until one works
# ═══════════════════════════════════════════════════════════════

async def _search_cascade(query: str) -> list[dict[str, str]]:
    """Try search providers in order until one returns results."""

    # 1. Brave Search API (most reliable from datacenter IPs)
    if BRAVE_SEARCH_API_KEY:
        try:
            results = await _brave_search(query)
            if results:
                logger.debug("Brave Search returned %d results", len(results))
                return results
        except Exception as exc:
            logger.debug("Brave Search failed: %s", exc)

    # 2. DuckDuckGo Lite (more tolerant of datacenter IPs)
    try:
        results = await _ddg_lite_search(query)
        if results:
            logger.debug("DDG Lite returned %d results", len(results))
            return results
    except Exception as exc:
        logger.debug("DDG Lite failed: %s", exc)

    # 3. DuckDuckGo Instant Answer + HTML fallback
    try:
        results = await _search_duckduckgo(query)
        if results:
            logger.debug("DDG Classic returned %d results", len(results))
            return results
    except Exception as exc:
        logger.debug("DDG Classic failed: %s", exc)

    return []


# ═══════════════════════════════════════════════════════════════
# Brave Search API (free tier)
# ═══════════════════════════════════════════════════════════════

async def _brave_search(query: str) -> list[dict[str, str]]:
    """Search via Brave Search API. Requires BRAVE_SEARCH_API_KEY."""
    results: list[dict[str, str]] = []

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": MAX_RESULTS},
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": BRAVE_SEARCH_API_KEY,
            },
        )

        if response.status_code != 200:
            logger.debug("Brave Search HTTP %d", response.status_code)
            return results

        data = response.json()
        web_results = data.get("web", {}).get("results", [])

        for item in web_results[:MAX_RESULTS]:
            title = str(item.get("title", "")).strip()
            snippet = str(item.get("description", "")).strip()
            url = str(item.get("url", "")).strip()

            if title and url:
                results.append({
                    "title": sanitize_text(title, 200),
                    "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
                    "url": _clean_url(url),
                    "source": _extract_domain(url),
                })

    return results


# ═══════════════════════════════════════════════════════════════
# DuckDuckGo Lite (more datacenter-friendly)
# ═══════════════════════════════════════════════════════════════

async def _ddg_lite_search(query: str) -> list[dict[str, str]]:
    """Parse DuckDuckGo Lite — a simplified page more tolerant of server IPs."""
    results: list[dict[str, str]] = []

    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    ) as client:
        url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"
        response = await client.get(url)

        if response.status_code != 200:
            return results

        body = response.text

        # DDG Lite uses table rows with class "result-link" and "result-snippet"
        # Pattern: <a rel="nofollow" href="URL" class="result-link">TITLE</a>
        link_pattern = re.compile(
            r'<a\s+[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
            re.DOTALL | re.IGNORECASE,
        )
        snippet_pattern = re.compile(
            r'<td\s+class="result-snippet"[^>]*>(.*?)</td>',
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

    return results


# ═══════════════════════════════════════════════════════════════
# DuckDuckGo Classic (Instant Answer + HTML)
# ═══════════════════════════════════════════════════════════════

async def _search_duckduckgo(query: str) -> list[dict[str, str]]:
    """Classic DDG search: Instant Answer API + HTML page parsing."""
    results: list[dict[str, str]] = []

    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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


# ═══════════════════════════════════════════════════════════════
# Utility functions
# ═══════════════════════════════════════════════════════════════

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
    for sep in (" - ", " — ", ": ", ". "):
        if sep in text:
            return sanitize_text(text.split(sep)[0], 100)
    return sanitize_text(text[:80], 100)
