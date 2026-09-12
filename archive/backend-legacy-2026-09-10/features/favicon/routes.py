# backend/features/favicon/routes.py

"""
Favicon HTTP proxy endpoint.
"""

from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from backend.api.dependencies import ServicesDep
from backend.core.security import validate_url
from .service import cache_key, fetch_favicon, get_cached_icon, is_trusted_redirect, store_icon

router = APIRouter(prefix="/api", tags=["presentation"])


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

    key = cache_key(target_url)
    cached = get_cached_icon(key)
    if cached is not None:
        body, media_type = cached
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
        )

    try:
        body, media_type = await fetch_favicon(target_url, services.http_client)
    except (httpx.HTTPError, ValueError):
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    store_icon(key, body, media_type)
    return Response(
        content=body,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
    )
