# backend/features/favicon/service.py

"""
SSRF-safe favicon fetching and caching service.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from urllib.parse import quote, urlparse

import httpx

_CACHE_TTL_SECONDS = 86_400
_CACHE_MAX_ITEMS = 256
_MAX_FAVICON_BYTES = 65_536
_ALLOWED_MEDIA_TYPES = {
    "image/png",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/webp",
    "image/jpeg",
}
_FAVICON_SERVICE_HOST = "www.google.com"

_cache: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()


def cache_key(target_url: str) -> str:
    parsed = urlparse(target_url)
    scheme = (parsed.scheme or "").strip().lower()
    hostname = (parsed.hostname or "").strip().lower()
    if not scheme or not hostname:
        raise ValueError("Invalid target URL origin for cache key")
    return f"{scheme}://{hostname}"


def get_cached_icon(key: str) -> tuple[bytes, str] | None:
    item = _cache.get(key)
    if item is None:
        return None
    expires_at, body, media_type = item
    if expires_at <= time.monotonic():
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return body, media_type


def store_icon(key: str, body: bytes, media_type: str) -> None:
    _cache[key] = (time.monotonic() + _CACHE_TTL_SECONDS, body, media_type)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_MAX_ITEMS:
        _cache.popitem(last=False)


def is_trusted_redirect(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme.lower() != "https":
        return False

    if parsed.username is not None or parsed.password is not None:
        return False

    try:
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return False

    return bool(hostname and (hostname == _FAVICON_SERVICE_HOST or hostname.endswith(".gstatic.com")))


async def fetch_favicon(target_url: str, client: httpx.AsyncClient) -> tuple[bytes, str]:
    parsed = urlparse(target_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    service_url = f"https://www.google.com/s2/favicons?domain_url={quote(origin, safe='')}&sz=32"

    response = await client.get(service_url, follow_redirects=False)
    if response.is_redirect:
        redirect_url = str(response.headers.get("location", "")).strip()
        if not is_trusted_redirect(redirect_url):
            raise ValueError("Favicon service returned an untrusted redirect")
        response = await client.get(redirect_url, follow_redirects=False)

    media_type = str(response.headers.get("content-type", "")).split(";", 1)[0].strip().lower()
    body = response.content
    if response.status_code != 200 or media_type not in _ALLOWED_MEDIA_TYPES:
        raise ValueError("Favicon service did not return a supported image")
    if not body or len(body) > _MAX_FAVICON_BYTES:
        raise ValueError("Favicon image is empty or exceeds the size limit")
    return body, media_type
