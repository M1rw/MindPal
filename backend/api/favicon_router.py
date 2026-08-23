"""Safe same-origin favicon delivery for rich response source links."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Annotated
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from backend.api.dependencies import ServicesDep
from backend.core.security import validate_url

router = APIRouter(prefix="/api", tags=["presentation"])

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

# The process-local cache is intentionally bounded. It reduces repeat lookups without
# retaining user data or turning the endpoint into an open image proxy.
_cache: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()


def _cache_key(target_url: str) -> str:
    parsed = urlparse(target_url)
    scheme = (parsed.scheme or "").strip().lower()
    hostname = (parsed.hostname or "").strip().lower()
    if not scheme or not hostname:
        raise ValueError("Invalid target URL origin for cache key")
    return f"{scheme}://{hostname}"


def _cached_icon(key: str) -> tuple[bytes, str] | None:
    item = _cache.get(key)
    if item is None:
        return None
    expires_at, body, media_type = item
    if expires_at <= time.monotonic():
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return body, media_type


def _store_icon(key: str, body: bytes, media_type: str) -> None:
    _cache[key] = (time.monotonic() + _CACHE_TTL_SECONDS, body, media_type)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_MAX_ITEMS:
        _cache.popitem(last=False)


def _image_media_type(response: httpx.Response) -> str:
    return str(response.headers.get("content-type", "")).split(";", 1)[0].strip().lower()


def _is_trusted_redirect(url: str) -> bool:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (hostname == _FAVICON_SERVICE_HOST or hostname.endswith(".gstatic.com"))


async def _fetch_favicon(target_url: str, client: httpx.AsyncClient) -> tuple[bytes, str]:
    parsed = urlparse(target_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    service_url = (
        "https://www.google.com/s2/favicons?domain_url="
        f"{quote(origin, safe='')}&sz=32"
    )

    response = await client.get(service_url, follow_redirects=False)
    if response.is_redirect:
        redirect_url = str(response.headers.get("location", "")).strip()
        if not _is_trusted_redirect(redirect_url):
            raise ValueError("Favicon service returned an untrusted redirect")
        response = await client.get(redirect_url, follow_redirects=False)

    media_type = _image_media_type(response)
    body = response.content
    if response.status_code != 200 or media_type not in _ALLOWED_MEDIA_TYPES:
        raise ValueError("Favicon service did not return a supported image")
    if not body or len(body) > _MAX_FAVICON_BYTES:
        raise ValueError("Favicon image is empty or exceeds the size limit")
    return body, media_type


@router.get("/favicon")
async def get_favicon(
    url: Annotated[str, Query(min_length=8, max_length=2_048)],
    services: ServicesDep,
) -> Response:
    """Return a small verified site icon through MindPal's own origin."""
    try:
        target_url = validate_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid favicon URL") from exc

    key = _cache_key(target_url)
    cached = _cached_icon(key)
    if cached is not None:
        body, media_type = cached
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
        )

    try:
        body, media_type = await _fetch_favicon(target_url, services.http_client)
    except (httpx.HTTPError, ValueError):
        # A transparent response avoids a broken-image glyph while revealing no
        # outbound-fetch detail to the browser.
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    _store_icon(key, body, media_type)
    return Response(
        content=body,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
    )
