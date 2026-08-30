"""
Shared builder utilities (HTTP client, settings, etc.).

These are used by multiple services and built first.
"""

import httpx

from backend.core.config import Settings


def build_http_client(settings: Settings) -> httpx.AsyncClient:
    """
    Build shared HTTP client for provider calls.

    All LLM, TTS, and third-party providers use this client.
    Configured with sensible defaults for API calls:
    - Timeout: from settings
    - Connection pooling: 100 max, 20 keepalive
    - Keepalive expiry: 30s
    - No redirects (safety/security)
    - User-Agent: MindPal/{version}

    Args:
        settings: Application settings

    Returns:
        Configured AsyncClient ready for use
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.LLM_TIMEOUT_SECONDS, connect=5.0),
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=30.0,
        ),
        follow_redirects=False,
        headers={"User-Agent": f"MindPal/{settings.VERSION}"},
    )
