# Test in-memory cache

import pytest
import asyncio
from datetime import datetime, timedelta
from backend.services.core.cache import InMemoryCache, CacheKey


@pytest.fixture
def cache():
    return InMemoryCache(max_size=100, default_ttl_seconds=60)


@pytest.mark.asyncio
async def test_cache_get_set(cache):
    """Test basic get/set operations."""
    
    await cache.set("key1", "value1")
    result = await cache.get("key1")
    
    assert result == "value1"


@pytest.mark.asyncio
async def test_cache_miss(cache):
    """Test cache miss returns None."""
    
    result = await cache.get("nonexistent")
    assert result is None


@pytest.mark.asyncio
async def test_cache_ttl_expiration(cache):
    """Test TTL expiration."""
    
    # Set with short TTL
    await cache.set("key1", "value1", ttl_seconds=1)
    
    # Should exist immediately
    result = await cache.get("key1")
    assert result == "value1"
    
    # Wait for expiration
    await asyncio.sleep(1.1)
    
    # Should be expired
    result = await cache.get("key1")
    assert result is None


@pytest.mark.asyncio
async def test_cache_delete(cache):
    """Test explicit deletion."""
    
    await cache.set("key1", "value1")
    await cache.delete("key1")
    
    result = await cache.get("key1")
    assert result is None


@pytest.mark.asyncio
async def test_cache_lru_eviction(cache):
    """Test LRU eviction when max_size exceeded."""
    
    # Cache with max_size=2
    small_cache = InMemoryCache(max_size=2)
    
    await small_cache.set("key1", "value1")
    await small_cache.set("key2", "value2")
    
    # Access key1 to mark as recently used
    await small_cache.get("key1")
    
    # Add key3, should evict key2 (least recently used)
    await small_cache.set("key3", "value3")
    
    # key1 should still exist
    assert await small_cache.get("key1") == "value1"
    
    # key3 should exist
    assert await small_cache.get("key3") == "value3"
    
    # key2 should be evicted
    assert await small_cache.get("key2") is None


@pytest.mark.asyncio
async def test_cache_statistics(cache):
    """Test cache statistics."""
    
    await cache.set("key1", "value1")
    await cache.get("key1")  # hit
    await cache.get("key2")  # miss
    
    stats = cache.get_statistics()
    
    assert stats["total_gets"] == 2
    assert stats["cache_hits"] == 1
    assert stats["cache_misses"] == 1
    assert stats["hit_rate"] == pytest.approx(0.5)


def test_cache_key_builder():
    """Test CacheKey utility class."""
    
    key = CacheKey.feature("my_feature", {"id": 123})
    assert key.startswith("feature:")
    
    key = CacheKey.safety_rule("rule_123")
    assert key == "safety_rule:rule_123"
    
    key = CacheKey.memory("user_456")
    assert key.startswith("memory:")

