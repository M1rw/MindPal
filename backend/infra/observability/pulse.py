"""Platform pulse: how busy MindPal is right now, across every instance.

Each process keeps small per-minute counters (active people, requests, LLM
calls, failures, rate limits, latency, tokens) and flushes them as one
document per instance per minute (`platform_pulse/{YYYYMMDDHHMM}:{instance}`).
Flushing is opportunistic, piggybacked on normal traffic, so it works on
serverless without background threads, and a flush rewrites the same
cumulative document, so it is idempotent.

Readers merge the last few minutes from every instance (cached briefly) into a
`PulseSnapshot`, and `backend.domain.dynamic.policy` turns that into a load
level that drives non-essential work. Active people are counted by a short
one-way hash; no identifiers, prompts, or content are stored.

This replaces per-event metric documents, which wrote one row per LLM call.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Set

from backend.configs.runtime import dynamic_config

logger = logging.getLogger("mindpal.pulse")

PULSE_COLLECTION = "platform_pulse"
INSTANCE_ID = uuid.uuid4().hex[:10]


def _config() -> Dict[str, Any]:
    return dynamic_config()["pulse"]


def minute_bucket(ts: float) -> str:
    return time.strftime("%Y%m%d%H%M", time.gmtime(ts))


def _person_token(identity: str) -> str:
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]


@dataclass
class _Bucket:
    users: Set[str] = field(default_factory=set)
    requests: int = 0
    llm_calls: int = 0
    llm_failures: int = 0
    llm_rate_limited: int = 0
    llm_latency_ms: int = 0
    tokens: int = 0
    quality: Dict[str, int] = field(default_factory=dict)

    def to_document(self, bucket: str, cap: int) -> Dict[str, Any]:
        return {
            "bucket": bucket,
            "instance": INSTANCE_ID,
            "users": sorted(self.users)[:cap],
            "requests": self.requests,
            "llm_calls": self.llm_calls,
            "llm_failures": self.llm_failures,
            "llm_rate_limited": self.llm_rate_limited,
            "llm_latency_ms": self.llm_latency_ms,
            "tokens": self.tokens,
            "quality": dict(self.quality),
            "expires_at": time.time() + int(_config()["retention_hours"]) * 3600,
        }


@dataclass(frozen=True)
class PulseSnapshot:
    active_users: int
    requests_per_minute: float
    llm_calls_per_minute: float
    llm_error_ratio: float
    llm_rate_limited_ratio: float
    llm_latency_ms: float
    tokens_per_minute: float
    instances: int
    window_minutes: int
    source: str  # "store" or "local"
    quality: Dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {key: getattr(self, key) for key in self.__dataclass_fields__}


class PlatformPulse:
    def __init__(self, store_factory: Any = None, clock: Any = time.time) -> None:
        self._lock = threading.Lock()
        self._buckets: Dict[str, _Bucket] = {}
        self._dirty: Set[str] = set()
        self._last_flush = 0.0
        self._store_factory = store_factory
        self._clock = clock
        self._snapshot: Optional[tuple[float, PulseSnapshot]] = None

    # -- recording (hot path: no I/O unless a flush is due) -----------------

    def _bucket(self, now: float) -> _Bucket:
        key = minute_bucket(now)
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = self._buckets[key] = _Bucket()
            window = int(_config()["window_minutes"])
            for stale in sorted(self._buckets)[: max(0, len(self._buckets) - window - 1)]:
                self._buckets.pop(stale, None)
                self._dirty.discard(stale)
        self._dirty.add(key)
        return bucket

    def record_activity(self, identity: str) -> None:
        """Someone used MindPal (account key or hashed network peer)."""
        if not identity:
            return
        now = self._clock()
        with self._lock:
            bucket = self._bucket(now)
            bucket.requests += 1
            if len(bucket.users) < int(_config()["max_users_per_bucket"]):
                bucket.users.add(_person_token(identity))
        self._maybe_flush(now)

    def record_quality(self, signal: str, count: int = 1) -> None:
        """Reply-quality signals: thumbs, reactions, stock sentences dropped, replies."""
        if count <= 0:
            return
        now = self._clock()
        with self._lock:
            bucket = self._bucket(now)
            bucket.quality[signal[:32]] = bucket.quality.get(signal[:32], 0) + int(count)
        self._maybe_flush(now)

    def record_llm(self, *, success: bool, latency_ms: int, rate_limited: bool = False, tokens: int = 0) -> None:
        now = self._clock()
        with self._lock:
            bucket = self._bucket(now)
            bucket.llm_calls += 1
            bucket.llm_failures += 0 if success else 1
            bucket.llm_rate_limited += 1 if rate_limited else 0
            bucket.llm_latency_ms += max(0, int(latency_ms))
            bucket.tokens += max(0, int(tokens))
        self._maybe_flush(now)

    # -- flushing ------------------------------------------------------------

    def _store(self) -> Any:
        if self._store_factory is not None:
            return self._store_factory()
        from backend.infra.store.store import get_store

        return get_store()

    def _maybe_flush(self, now: float) -> None:
        if now - self._last_flush < int(_config()["flush_interval_seconds"]):
            return
        self.flush(now)

    def flush(self, now: Optional[float] = None) -> int:
        current = self._clock() if now is None else now
        with self._lock:
            self._last_flush = current
            cap = int(_config()["max_users_per_bucket"])
            documents = {key: self._buckets[key].to_document(key, cap) for key in self._dirty if key in self._buckets}
            self._dirty.clear()
        written = 0
        try:
            store = self._store()
            for key, document in documents.items():
                store.set_document(PULSE_COLLECTION, f"{key}:{INSTANCE_ID}", document)
                written += 1
        except Exception as exc:
            # Observability must never break a request. Unwritten buckets are
            # rewritten cumulatively on the next flush.
            with self._lock:
                self._dirty.update(documents)
            logger.warning("pulse_flush_skipped error=%s", type(exc).__name__)
        return written

    # -- reading -------------------------------------------------------------

    def snapshot(self, *, fresh: bool = False) -> PulseSnapshot:
        now = self._clock()
        cached = self._snapshot
        if not fresh and cached and now - cached[0] < int(_config()["snapshot_cache_seconds"]):
            return cached[1]
        window = int(_config()["window_minutes"])
        keys = [minute_bucket(now - 60 * offset) for offset in range(window)]
        merged: Dict[str, Dict[str, Any]] = {}
        source = "store"
        try:
            store = self._store()
            for key in keys:
                for doc_id, document in store.iter_documents(PULSE_COLLECTION, prefix=f"{key}:"):
                    merged[doc_id] = document
        except Exception as exc:
            source = "local"
            logger.warning("pulse_read_local_only error=%s", type(exc).__name__)
        with self._lock:
            cap = int(_config()["max_users_per_bucket"])
            for key in keys:
                if key in self._buckets:
                    # This instance's own counters are always the freshest.
                    merged[f"{key}:{INSTANCE_ID}"] = self._buckets[key].to_document(key, cap)
        snap = _summarize(merged.values(), window, source)
        self._snapshot = (now, snap)
        return snap

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
            self._dirty.clear()
            self._snapshot = None
            self._last_flush = 0.0


def _summarize(documents: Any, window: int, source: str) -> PulseSnapshot:
    users: Set[str] = set()
    instances: Set[str] = set()
    requests = calls = failures = limited = latency = tokens = 0
    quality: Dict[str, int] = {}
    for doc in documents:
        for signal, count in (doc.get("quality") or {}).items():
            quality[str(signal)] = quality.get(str(signal), 0) + int(count or 0)
        users.update(str(user) for user in doc.get("users") or [])
        instances.add(str(doc.get("instance") or ""))
        requests += int(doc.get("requests") or 0)
        calls += int(doc.get("llm_calls") or 0)
        failures += int(doc.get("llm_failures") or 0)
        limited += int(doc.get("llm_rate_limited") or 0)
        latency += int(doc.get("llm_latency_ms") or 0)
        tokens += int(doc.get("tokens") or 0)
    return PulseSnapshot(
        active_users=len(users),
        requests_per_minute=round(requests / window, 2),
        llm_calls_per_minute=round(calls / window, 2),
        llm_error_ratio=round(failures / calls, 4) if calls else 0.0,
        llm_rate_limited_ratio=round(limited / calls, 4) if calls else 0.0,
        llm_latency_ms=round(latency / calls, 1) if calls else 0.0,
        tokens_per_minute=round(tokens / window, 1),
        instances=len(instances - {""}),
        window_minutes=window,
        source=source,
        quality=quality,
    )


_PULSE = PlatformPulse()


def platform_pulse() -> PlatformPulse:
    return _PULSE


def purge_old_pulse(store: Any, *, now: Optional[float] = None) -> int:
    cutoff = time.time() if now is None else now
    removed = 0
    for doc_id, document in list(store.iter_documents(PULSE_COLLECTION)):
        expires = document.get("expires_at")
        if isinstance(expires, (int, float)) and expires <= cutoff and store.delete_document(PULSE_COLLECTION, doc_id):
            removed += 1
    return removed
