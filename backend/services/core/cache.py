# Unified Caching Layer

from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Any, Generic, Optional, TypeVar, Callable, Awaitable
import asyncio
import hashlib
import json
import logging

logger = logging.getLogger(__name__)

K = TypeVar('K')
V = TypeVar('V')


class CacheEntry(Generic[V]):
    """Represents a cached value with expiration."""
    
    def __init__(self, value: V, ttl_seconds: int):
        self.value = value
        self.expires_at = datetime.utcnow() + timedelta(seconds=ttl_seconds)
        self.created_at = datetime.utcnow()
        self.access_count = 0
    
    def is_expired(self) -> bool:
        """Check if entry has expired."""
        return datetime.utcnow() > self.expires_at
    
    def touch(self) -> None:
        """Update access count and timestamp."""
        self.access_count += 1


class Cache(ABC, Generic[K, V]):
    """Abstract cache interface."""
    
    @abstractmethod
    async def get(self, key: K) -> Optional[V]:
        """Get value from cache."""
        ...
    
    @abstractmethod
    async def set(self, key: K, value: V, ttl_seconds: int = 300) -> None:
        """Set value in cache with TTL."""
        ...
    
    @abstractmethod
    async def delete(self, key: K) -> None:
        """Delete value from cache."""
        ...
    
    @abstractmethod
    async def clear(self) -> None:
        """Clear all cache entries."""
        ...
    
    @abstractmethod
    async def get_stats(self) -> dict[str, Any]:
        """Get cache statistics."""
        ...


class InMemoryCache(Cache[K, V]):
    """
    Thread-safe in-process cache with TTL and LRU eviction.
    
    Suitable for:
    - Feature flags
    - Safety rules
    - Clinical frameworks
    - User preferences
    
    Not suitable for:
    - Shared state across instances
    - Persistent data
    """
    
    def __init__(self, max_size: int = 10_000, cleanup_interval: int = 300):
        self._data: dict[K, CacheEntry[V]] = {}
        self._lock = asyncio.Lock()
        self._max_size = max_size
        self._cleanup_interval = cleanup_interval
        self._access_order: list[K] = []
        self._stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
        }
        self._cleanup_task: Optional[asyncio.Task] = None
    
    async def start_cleanup(self) -> None:
        """Start background cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
    
    async def stop_cleanup(self) -> None:
        """Stop background cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None
    
    async def _cleanup_loop(self) -> None:
        """Periodically remove expired entries."""
        try:
            while True:
                await asyncio.sleep(self._cleanup_interval)
                await self._cleanup_expired()
        except asyncio.CancelledError:
            logger.debug("Cache cleanup task cancelled")
    
    async def _cleanup_expired(self) -> None:
        """Remove all expired entries."""
        async with self._lock:
            expired_keys = [
                k for k, entry in self._data.items()
                if entry.is_expired()
            ]
            for key in expired_keys:
                del self._data[key]
                self._access_order.remove(key)
            
            if expired_keys:
                logger.debug(f"Cleaned up {len(expired_keys)} expired cache entries")
    
    async def get(self, key: K) -> Optional[V]:
        """Get value from cache."""
        async with self._lock:
            entry = self._data.get(key)
            
            if entry is None:
                self._stats["misses"] += 1
                return None
            
            if entry.is_expired():
                del self._data[key]
                self._access_order.remove(key)
                self._stats["misses"] += 1
                return None
            
            entry.touch()
            self._stats["hits"] += 1
            return entry.value
    
    async def set(self, key: K, value: V, ttl_seconds: int = 300) -> None:
        """Set value in cache with TTL."""
        async with self._lock:
            # Remove old entry if exists
            if key in self._data:
                self._access_order.remove(key)
            
            # Add to cache
            self._data[key] = CacheEntry(value, ttl_seconds)
            self._access_order.append(key)
            
            # Evict if size exceeded (LRU: remove oldest accessed)
            while len(self._data) > self._max_size:
                oldest_key = self._access_order.pop(0)
                del self._data[oldest_key]
                self._stats["evictions"] += 1
    
    async def delete(self, key: K) -> None:
        """Delete value from cache."""
        async with self._lock:
            if key in self._data:
                del self._data[key]
                self._access_order.remove(key)
    
    async def clear(self) -> None:
        """Clear all cache entries."""
        async with self._lock:
            self._data.clear()
            self._access_order.clear()
    
    async def get_stats(self) -> dict[str, Any]:
        """Get cache statistics."""
        async with self._lock:
            total_requests = self._stats["hits"] + self._stats["misses"]
            hit_ratio = (
                self._stats["hits"] / total_requests if total_requests > 0 else 0.0
            )
            
            return {
                "size": len(self._data),
                "max_size": self._max_size,
                "hits": self._stats["hits"],
                "misses": self._stats["misses"],
                "hit_ratio": hit_ratio,
                "evictions": self._stats["evictions"],
            }


class CachedRepository:
    """
    Mixin class for repositories to add caching.
    
    Usage:
        class UserRepository(CachedRepository):
            async def get_user(self, user_id: str) -> User:
                return await self.get_cached(
                    f"user:{user_id}",
                    lambda: self._load_user(user_id)
                )
    """
    
    def __init__(self, cache: Cache, ttl_seconds: int = 300):
        self._cache = cache
        self._cache_ttl = ttl_seconds
    
    async def get_cached(
        self,
        key: str,
        loader: Callable[[], Awaitable[V]],
        ttl_seconds: Optional[int] = None,
    ) -> V:
        """
        Get from cache or load and cache.
        
        Args:
            key: Cache key
            loader: Async function to load value if not cached
            ttl_seconds: Custom TTL (uses instance default if None)
            
        Returns:
            Cached or loaded value
        """
        # Try cache first
        cached = await self._cache.get(key)
        if cached is not None:
            logger.debug(f"Cache hit: {key}")
            return cached
        
        # Load and cache
        logger.debug(f"Cache miss, loading: {key}")
        value = await loader()
        await self._cache.set(key, value, ttl_seconds or self._cache_ttl)
        return value
    
    async def invalidate_cache(self, key: str) -> None:
        """Invalidate a specific cache entry."""
        await self._cache.delete(key)
    
    async def invalidate_pattern(self, pattern: str) -> None:
        """Invalidate multiple entries by pattern."""
        # This requires cache to support pattern deletion
        # For InMemoryCache, we'd need to iterate
        logger.warning("Pattern invalidation not implemented for current cache backend")


class CacheKey:
    """Utility class for generating consistent cache keys."""
    
    @staticmethod
    def feature(feature_name: str) -> str:
        """Generate feature flag cache key."""
        return f"feature:{feature_name}"
    
    @staticmethod
    def safety_rule(rule_id: str) -> str:
        """Generate safety rule cache key."""
        return f"safety_rule:{rule_id}"
    
    @staticmethod
    def user_profile(user_id_hash: str) -> str:
        """Generate user profile cache key."""
        return f"profile:{user_id_hash}"
    
    @staticmethod
    def memory_graph(user_id_hash: str) -> str:
        """Generate memory graph cache key."""
        return f"memory:{user_id_hash}"
    
    @staticmethod
    def llm_response(prompt_hash: str, model: str) -> str:
        """Generate LLM response cache key."""
        return f"llm_response:{model}:{prompt_hash}"
    
    @staticmethod
    def hash_content(content: Any) -> str:
        """Hash any content for cache key."""
        encoded = json.dumps(
            content,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str
        ).encode('utf-8')
        return hashlib.sha256(encoded).hexdigest()

