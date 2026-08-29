# backend/features/favicon/__init__.py

"""
Favicon feature public exports.
"""

from .routes import router
from .service import cache_key, fetch_favicon, get_cached_icon, is_trusted_redirect, store_icon

__all__ = [
    "router",
    "cache_key",
    "fetch_favicon",
    "get_cached_icon",
    "is_trusted_redirect",
    "store_icon",
]
