from __future__ import annotations

import threading
from typing import Any, Dict, Iterator, List, Optional, Tuple

from backend.infra.store.shared import Mutator


class InMemoryStore:
    """Thread-safe, non-durable document store for tests, local work, and caches."""

    provider_name = "memory"
    durable = False

    def __init__(self, *, max_docs_per_collection: int = 0) -> None:
        self._collections: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._max_docs = max_docs_per_collection
        self._lock = threading.RLock()

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            doc = self._collections.get(collection, {}).get(doc_id)
            return dict(doc) if doc is not None else None

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        with self._lock:
            col = self._collections.setdefault(collection, {})
            col.pop(doc_id, None)  # re-insert so eviction order tracks recency
            col[doc_id] = dict(data)
            if self._max_docs and len(col) > self._max_docs:
                for stale in list(col)[: len(col) - self._max_docs]:
                    col.pop(stale, None)

    def delete_document(self, collection: str, doc_id: str) -> bool:
        with self._lock:
            return self._collections.get(collection, {}).pop(doc_id, None) is not None

    def iter_documents(self, collection: str, prefix: str = "") -> Iterator[Tuple[str, Dict[str, Any]]]:
        with self._lock:
            items = [
                (doc_id, dict(doc))
                for doc_id, doc in self._collections.get(collection, {}).items()
                if not prefix or doc_id.startswith(prefix)
            ]
        return iter(items)

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        return [doc for _doc_id, doc in self.iter_documents(collection, prefix)]

    def query_documents(self, collection: str, field: str, value: Any) -> List[Tuple[str, Dict[str, Any]]]:
        return [(doc_id, doc) for doc_id, doc in self.iter_documents(collection) if doc.get(field) == value]

    def transact(self, collection: str, doc_id: str, mutate: Mutator[Any]) -> Any:
        with self._lock:
            current = self._collections.get(collection, {}).get(doc_id)
            return mutate(
                dict(current) if current is not None else None,
                lambda data: self.set_document(collection, doc_id, data),
            )


__all__ = ["InMemoryStore"]
