# backend/infra/store/store.py — Document Store Gateway

from __future__ import annotations

from typing import Any, Dict, List, Optional


class InMemoryStore:
    """In-memory key-value document store for test/dev and fallback."""

    def __init__(self) -> None:
        self._collections: Dict[str, Dict[str, Dict[str, Any]]] = {}

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        return self._collections.get(collection, {}).get(doc_id)

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        if collection not in self._collections:
            self._collections[collection] = {}
        self._collections[collection][doc_id] = dict(data)

    def delete_document(self, collection: str, doc_id: str) -> bool:
        if collection in self._collections and doc_id in self._collections[collection]:
            del self._collections[collection][doc_id]
            return True
        return False

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        col = self._collections.get(collection, {})
        if not prefix:
            return list(col.values())
        return [v for k, v in col.items() if k.startswith(prefix)]


_GLOBAL_STORE = InMemoryStore()


def get_store() -> InMemoryStore:
    return _GLOBAL_STORE
