"""Text embeddings for search by meaning, with a hard fallback to keywords.

Used for the wellness guidance library and conversation digests. Every call
is best effort: a missing key, a timeout, or a provider error returns None and
the caller keeps its keyword ranking. After a failure the client pauses for a
minute instead of adding a timeout to every turn.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from typing import List, Optional, Protocol, Sequence

from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.embeddings")

EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 256
_TIMEOUT_MS = 2500
_PAUSE_AFTER_FAILURE_S = 60.0
_QUERY_CACHE_SIZE = 512


class Embedder(Protocol):
    def embed(self, texts: Sequence[str], *, task: str) -> Optional[List[List[float]]]: ...


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def compact(vector: Sequence[float]) -> List[float]:
    """Round for storage (256 floats at 4 decimals is ~2 KB of JSON)."""
    return [round(float(value), 4) for value in vector]


class GeminiEmbedder:
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._paused_until = 0.0
        self._lock = threading.Lock()
        self._cache: "OrderedDict[tuple[str, str], List[float]]" = OrderedDict()
        self._client = None

    def _get_client(self):
        if self._client is None:
            from google import genai
            from google.genai import types

            self._client = genai.Client(api_key=self._api_key, http_options=types.HttpOptions(timeout=_TIMEOUT_MS))
        return self._client

    def embed(self, texts: Sequence[str], *, task: str) -> Optional[List[List[float]]]:
        items = [" ".join(str(t or "").split())[:2000] for t in texts]
        if not items or time.monotonic() < self._paused_until:
            return None
        results: List[Optional[List[float]]] = [self._cache.get((task, t)) for t in items]
        missing = [i for i, r in enumerate(results) if r is None]
        if missing:
            try:
                from google.genai import types

                response = self._get_client().models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=[items[i] for i in missing],
                    config=types.EmbedContentConfig(task_type=task, output_dimensionality=EMBEDDING_DIMENSIONS),
                )
                vectors = [list(e.values) for e in response.embeddings]
            except Exception as exc:
                self._paused_until = time.monotonic() + _PAUSE_AFTER_FAILURE_S
                logger.warning("embeddings_unavailable error=%s", type(exc).__name__)
                return None
            with self._lock:
                for index, vector in zip(missing, vectors):
                    results[index] = vector
                    self._cache[(task, items[index])] = vector
                    while len(self._cache) > _QUERY_CACHE_SIZE:
                        self._cache.popitem(last=False)
        return [r for r in results if r is not None]


_EMBEDDER: Optional[Embedder] = None
_EMBEDDER_LOCK = threading.Lock()


def get_embedder() -> Optional[Embedder]:
    """The configured embedder, or None when semantic search is off or unconfigured."""
    global _EMBEDDER
    settings = get_settings()
    if not settings.semantic_search_enabled():
        return None
    key = settings.resolved_gemini_api_key()
    if not key:
        return None
    with _EMBEDDER_LOCK:
        if _EMBEDDER is None:
            _EMBEDDER = GeminiEmbedder(key)
        return _EMBEDDER


def set_embedder(embedder: Optional[Embedder]) -> None:
    """Test hook."""
    global _EMBEDDER
    _EMBEDDER = embedder
