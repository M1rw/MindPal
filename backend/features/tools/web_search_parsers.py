# backend/features/tools/web_search_parsers.py

"""
HTML and API response parsers for DuckDuckGo web search strategies.
"""

from __future__ import annotations

import html as html_module
import re
from urllib.parse import quote_plus, unquote, urlparse

import httpx

from backend.core.security import sanitize_text

MAX_SNIPPET_CHARS = 500
MAX_RESULTS = 5

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


async def ddg_html_search(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    response = await client.get(url, headers=_BROWSER_HEADERS, follow_redirects=True)

    if response.status_code != 200:
        return results

    body = response.text
    link_pattern = re.compile(r'<a\s+[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
    snippet_pattern = re.compile(r'<a\s+[^>]*class="result__snippet"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)

    links = link_pattern.findall(body)
    snippets = snippet_pattern.findall(body)

    if not links:
        link_pattern_alt = re.compile(r'<a\s+[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
        links = link_pattern_alt.findall(body)

    for i, (raw_url, raw_title) in enumerate(links[:MAX_RESULTS]):
        title = strip_html(raw_title).strip()
        snippet = strip_html(snippets[i]).strip() if i < len(snippets) else ""
        clean_url = resolve_ddg_redirect(raw_url)

        if title and clean_url:
            results.append({
                "title": sanitize_text(title, 200),
                "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
                "url": clean_url,
                "source": extract_domain(clean_url),
            })
    return results


async def ddg_instant_answer(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    url = f"https://api.duckduckgo.com/?q={quote_plus(query)}&format=json&no_html=1&skip_disambig=1"
    response = await client.get(url, headers={**_BROWSER_HEADERS, "Accept": "application/json"}, follow_redirects=True)

    if response.status_code != 200:
        return results

    data = response.json()
    abstract_text = str(data.get("AbstractText", "")).strip()
    abstract_url = str(data.get("AbstractURL", "")).strip()
    abstract_source = str(data.get("AbstractSource", "")).strip()

    if abstract_text and abstract_url:
        results.append({
            "title": abstract_source or "DuckDuckGo",
            "snippet": sanitize_text(abstract_text, MAX_SNIPPET_CHARS),
            "url": clean_url_string(abstract_url),
            "source": abstract_source,
        })

    answer = str(data.get("Answer", "")).strip()
    if answer:
        results.append({
            "title": "Direct Answer",
            "snippet": sanitize_text(answer, MAX_SNIPPET_CHARS),
            "url": "",
            "source": "DuckDuckGo",
        })

    for topic in (data.get("RelatedTopics") or [])[:5]:
        if not isinstance(topic, dict):
            continue
        text = str(topic.get("Text", "")).strip()
        first_url = str(topic.get("FirstURL", "")).strip()
        if text and first_url:
            results.append({
                "title": extract_title_from_text(text),
                "snippet": sanitize_text(text, MAX_SNIPPET_CHARS),
                "url": clean_url_string(first_url),
                "source": "DuckDuckGo",
            })

    return results


async def ddg_lite_search(client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"
    response = await client.post(url, data={"q": query}, headers=_BROWSER_HEADERS, follow_redirects=True)

    if response.status_code != 200:
        return results

    body = response.text
    link_pattern = re.compile(r'<a[^>]+href="(https?://[^"]+|//duckduckgo\.com/l/\?[^"]+)"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
    matches = link_pattern.findall(body)
    td_pattern = re.compile(r'<td[^>]*>\s*((?:(?!</td>).){40,}?)\s*</td>', re.DOTALL | re.IGNORECASE)
    td_texts = [strip_html(m).strip() for m in td_pattern.findall(body)]
    snippets = [t for t in td_texts if len(t) > 30 and not t.startswith("<")]

    seen_urls: set[str] = set()
    snippet_idx = 0
    for raw_url, raw_title in matches:
        clean_title = strip_html(raw_title).strip()
        clean_url = resolve_ddg_redirect(raw_url)
        if not clean_url or "duckduckgo.com" in clean_url or clean_url in seen_urls:
            continue
        seen_urls.add(clean_url)
        snippet = snippets[snippet_idx] if snippet_idx < len(snippets) else ""
        snippet_idx += 1
        if clean_title:
            results.append({
                "title": sanitize_text(clean_title, 200),
                "snippet": sanitize_text(snippet, MAX_SNIPPET_CHARS),
                "url": clean_url,
                "source": extract_domain(clean_url),
            })
            if len(results) >= MAX_RESULTS:
                break
    return results


def resolve_ddg_redirect(raw_url: str) -> str:
    if "uddg=" in raw_url:
        match = re.search(r"uddg=([^&]+)", raw_url)
        if match:
            return clean_url_string(unquote(match.group(1)))
    return clean_url_string(raw_url)


def clean_url_string(url: str) -> str:
    cleaned = url.strip()
    if cleaned.startswith("//"):
        cleaned = "https:" + cleaned
    if not cleaned.startswith(("http://", "https://")):
        return ""
    return cleaned


def extract_domain(url: str) -> str:
    try:
        parsed = urlparse(url)
        domain = (parsed.netloc or "").lower().replace("www.", "")
        return domain or "web"
    except Exception:
        return "web"


def extract_title_from_text(text: str) -> str:
    parts = text.split(" - ", 1)
    return parts[0].strip() if len(parts) > 1 else text[:60].strip()


def strip_html(html_str: str) -> str:
    text = re.sub(r"<[^>]+>", "", html_str)
    return html_module.unescape(text)
