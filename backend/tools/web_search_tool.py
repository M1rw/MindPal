# backend/tools/web_search_tool.py

"""
Web search tool for MindPal — DuckDuckGo-only, no paid APIs needed.

Search strategies (cascading fallback):
1. DuckDuckGo HTML search — reliable, returns real web results
2. DuckDuckGo Instant Answer API — structured facts, Wikipedia summaries
3. DuckDuckGo Lite — simplified HTML for edge cases

All three are free and require no API keys.
"""

from __future__ import annotations

import asyncio
import html as html_module
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
REQUEST_TIMEOUT = 6.0

# Rate limit tracking (per-request via context metadata)
_RATE_LIMIT_KEY = "_web_search_count"
_MAX_SEARCHES_PER_REQUEST = 3

# Browser-like headers to avoid bot detection
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}


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

        logger.info("Web search executing for query: '%s'", query[:100])

        try:
            results = await _search_cascade(query)

            if not results:
                logger.info("Web search returned 0 results for '%s'", query[:80])
                return ToolResult(data={
                    "query": query,
                    "results": [],
                    "note": "No results found. Try rephrasing the query.",
                })

            logger.info("Web search returned %d results for '%s'", len(results), query[:80])
            return ToolResult(data={
                "query": query,
                "results": results[:MAX_RESULTS],
                "result_count": len(results),
            })

        except asyncio.TimeoutError:
            logger.warning("Web search timed out for '%s'", query[:80])
            return ToolResult(
                error="Search timed out. Try again with a shorter query.",
                data={"query": query},
            )
        except Exception as exc:
            logger.warning("Web search failed: %s — %s", type(exc).__name__, exc)
            return ToolResult(
                error="Search temporarily unavailable. Please try again.",
                data={"query": query},
            )


# ═══════════════════════════════════════════════════════════════
# Search cascade — try strategies in order until one works
# ═══════════════════════════════════════════════════════════════

async def _search_cascade(query: str) -> list[dict[str, str]]:
    """Try search strategies in order until one returns results."""
    results: list[dict[str, str]] = []

    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        headers=_BROWSER_HEADERS,
    ) as client:

        # Strategy 1: DDG HTML search (most reliable for real web results)
        try:
            html_results = await _ddg_html_search(client, query)
            if html_results:
                logger.debug("DDG HTML returned %d results", len(html_results))
                return html_results
        except Exception as exc:
            logger.debug("DDG HTML failed: %s", exc)

        # Strategy 2: DDG Instant Answer API (good for factual queries)
        try:
            instant_results = await _ddg_instant_answer(client, query)
            results.extend(instant_results)
            if results:
                logger.debug("DDG Instant Answer returned %d results", len(results))
                return results
        except Exception as exc:
            logger.debug("DDG Instant Answer failed: %s", exc)

        # Strategy 3: DDG Lite (last resort)
        try:
            lite_results = await _ddg_lite_search(client, query)
            if lite_results:
                logger.debug("DDG Lite returned %d results", len(lite_results))
                return lite_results
        except Exception as exc:
            logger.debug("DDG Lite failed: %s", exc)

    return results


# ═══════════════════════════════════════════════════════════════
# Strategy 1: DuckDuckGo HTML Search (primary)
# ═══════════════════════════════════════════════════════════════

async def _ddg_html_search(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    """
    Parse DuckDuckGo HTML search page.

    The HTML structure uses:
    - Links: <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL">TITLE</a>
    - Snippets: <a class="result__snippet" ...>SNIPPET TEXT</a>

    Note: The `class` attribute is NOT always the first attribute on the <a> tag.
    """
    results: list[dict[str, str]] = []

    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    response = await client.get(url)

    if response.status_code != 200:
        logger.debug("DDG HTML returned status %d", response.status_code)
        return results

    body = response.text

    # Pattern: <a ... class="result__a" ... href="URL">TITLE</a>
    # CRITICAL: class may NOT be the first attribute (e.g. rel="nofollow" comes first)
    link_pattern = re.compile(
        r'<a\s+[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
        re.DOTALL | re.IGNORECASE,
    )
    snippet_pattern = re.compile(
        r'<a\s+[^>]*class="result__snippet"[^>]*>(.*?)</a>',
        re.DOTALL | re.IGNORECASE,
    )

    links = link_pattern.findall(body)
    snippets = snippet_pattern.findall(body)

    if not links:
        # Fallback: try href before class (some DDG versions swap order)
        link_pattern_alt = re.compile(
            r'<a\s+[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>(.*?)</a>',
            re.DOTALL | re.IGNORECASE,
        )
        links = link_pattern_alt.findall(body)

    for i, (raw_url, raw_title) in enumerate(links[:MAX_RESULTS]):
        title = _strip_html(raw_title).strip()
        snippet = _strip_html(snippets[i]).strip() if i < len(snippets) else ""
        clean_url = _resolve_ddg_redirect(raw_url)

        if title and clean_url:
            results.append({
                "title": sanitize_text(title, 200),
                "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
                "url": clean_url,
                "source": _extract_domain(clean_url),
            })

    return results


# ═══════════════════════════════════════════════════════════════
# Strategy 2: DuckDuckGo Instant Answer API
# ═══════════════════════════════════════════════════════════════

async def _ddg_instant_answer(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    """
    Query DuckDuckGo Instant Answer API.
    Good for factual/definitional queries (Wikipedia-style).
    Not useful for current events or news.
    """
    results: list[dict[str, str]] = []

    url = f"https://api.duckduckgo.com/?q={quote_plus(query)}&format=json&no_html=1&skip_disambig=1"
    response = await client.get(url, headers={"Accept": "application/json"})

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
    for topic in (data.get("RelatedTopics") or [])[:5]:
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

    return results


# ═══════════════════════════════════════════════════════════════
# Strategy 3: DuckDuckGo Lite (last resort)
# ═══════════════════════════════════════════════════════════════

async def _ddg_lite_search(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    """
    Parse DuckDuckGo Lite page.

    DDG Lite uses table-based layout. Results are in <td> elements
    with links followed by snippet text in separate cells.
    """
    results: list[dict[str, str]] = []

    url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"
    response = await client.post(url, data={"q": query})

    if response.status_code != 200:
        return results

    body = response.text

    # DDG Lite wraps results in table rows. Links are regular <a> tags
    # pointing to DDG redirect URLs. Find all external links.
    link_pattern = re.compile(
        r'<a[^>]+href="(https?://[^"]+|//duckduckgo\.com/l/\?[^"]+)"[^>]*>(.*?)</a>',
        re.DOTALL | re.IGNORECASE,
    )
    matches = link_pattern.findall(body)

    # Extract snippet text from <td> elements that contain substantial text
    td_pattern = re.compile(r'<td[^>]*>\s*((?:(?!</td>).){40,}?)\s*</td>', re.DOTALL | re.IGNORECASE)
    td_texts = [_strip_html(m).strip() for m in td_pattern.findall(body)]
    # Filter to real snippets (not navigation etc)
    snippets = [t for t in td_texts if len(t) > 30 and not t.startswith("<")]

    seen_urls = set()
    snippet_idx = 0
    for raw_url, raw_title in matches:
        clean_title = _strip_html(raw_title).strip()
        clean_url = _resolve_ddg_redirect(raw_url)

        # Skip DDG internal links and duplicates
        if not clean_url or "duckduckgo.com" in clean_url:
            continue
        if clean_url in seen_urls:
            continue
        if not clean_title or len(clean_title) < 5:
            continue

        seen_urls.add(clean_url)
        snippet = snippets[snippet_idx] if snippet_idx < len(snippets) else ""
        snippet_idx += 1

        results.append({
            "title": sanitize_text(clean_title, 200),
            "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
            "url": clean_url,
            "source": _extract_domain(clean_url),
        })

        if len(results) >= MAX_RESULTS:
            break

    return results


# ═══════════════════════════════════════════════════════════════
# Utility functions
# ═══════════════════════════════════════════════════════════════

def _strip_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    cleaned = re.sub(r"<[^>]+>", "", text)
    return html_module.unescape(cleaned)


def _clean_url(url: str) -> str:
    """Strip tracking parameters from URLs."""
    cleaned = url.split("?utm_")[0]
    cleaned = cleaned.split("&utm_")[0]
    return cleaned.strip()


def _resolve_ddg_redirect(raw_url: str) -> str:
    """
    Resolve DuckDuckGo redirect URLs to actual destination.

    DDG uses several redirect formats:
    - //duckduckgo.com/l/?uddg=ENCODED_URL&amp;rut=HASH
    - //duckduckgo.com/l/?uddg=ENCODED_URL&rut=HASH
    - Direct URLs (no redirect)
    """
    # First decode HTML entities (DDG HTML uses &amp; not &)
    decoded = html_module.unescape(raw_url)

    # Handle protocol-relative URLs
    if decoded.startswith("//"):
        decoded = "https:" + decoded

    # Extract the actual URL from DDG redirect
    if "duckduckgo.com" in decoded and "uddg=" in decoded:
        match = re.search(r"uddg=([^&]+)", decoded)
        if match:
            actual_url = unquote(match.group(1))
            return _clean_url(actual_url)

    # If not a DDG redirect, return as-is (but clean)
    if decoded.startswith("http"):
        return _clean_url(decoded)

    return ""


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
