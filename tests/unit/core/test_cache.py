# tests/unit/core/test_cache.py

import pytest
import asyncio
from backend.services.core.cache import InMemoryCache


@pytest.mark.asyncio
async def test_in_memory_cache_set_and_get():
    cache = InMemoryCache[str, str](max_size=10)
    await cache.set("key1", "value1", ttl_seconds=60)
    
    val = await cache.get("key1")
    assert val == "value1"


@pytest.mark.asyncio
async def test_in_memory_cache_expiration():
    cache = InMemoryCache[str, str](max_size=10)
    await cache.set("key_exp", "val_exp", ttl_seconds=1)
    
    # Wait for expiration
    await asyncio.sleep(1.1)
    
    val = await cache.get("key_exp")
    assert val is None


@pytest.mark.asyncio
async def test_in_memory_cache_delete_and_clear():
    cache = InMemoryCache[str, str](max_size=10)
    await cache.set("a", "1", ttl_seconds=60)
    await cache.set("b", "2", ttl_seconds=60)
    
    await cache.delete("a")
    assert await cache.get("a") is None
    assert await cache.get("b") == "2"
    
    await cache.clear()
    assert await cache.get("b") is None
