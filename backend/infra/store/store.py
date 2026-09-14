# backend/infra/store/store.py — Document Store Gateway with Cloud Firestore Support

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

logger = logging.getLogger("mindpal.store")


class DocumentStore(Protocol):
    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]: ...
    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None: ...
    def delete_document(self, collection: str, doc_id: str) -> bool: ...
    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]: ...


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


class FirestoreStore:
    """Cloud Firestore document store provider for production with resilient memory fallback."""

    def __init__(self, db: Any) -> None:
        self._db = db
        self._fallback = InMemoryStore()
        self._cloud_available = True

    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        if not self._cloud_available:
            return self._fallback.get_document(collection, doc_id)
        try:
            doc_ref = self._db.collection(collection).document(doc_id)
            snapshot = doc_ref.get()
            if snapshot.exists:
                return snapshot.to_dict()
            return self._fallback.get_document(collection, doc_id)
        except Exception as e:
            logger.warning("Firestore get_document failed for %s/%s, falling back to memory store: %s", collection, doc_id, e)
            self._cloud_available = False
            return self._fallback.get_document(collection, doc_id)

    def set_document(self, collection: str, doc_id: str, data: Dict[str, Any]) -> None:
        self._fallback.set_document(collection, doc_id, data)
        if not self._cloud_available:
            return
        try:
            doc_ref = self._db.collection(collection).document(doc_id)
            doc_ref.set(data, merge=True)
        except Exception as e:
            logger.warning("Firestore set_document failed for %s/%s, using memory store: %s", collection, doc_id, e)
            self._cloud_available = False

    def delete_document(self, collection: str, doc_id: str) -> bool:
        fallback_res = self._fallback.delete_document(collection, doc_id)
        if not self._cloud_available:
            return fallback_res
        try:
            doc_ref = self._db.collection(collection).document(doc_id)
            doc_ref.delete()
            return True
        except Exception as e:
            logger.warning("Firestore delete_document failed for %s/%s, using memory store: %s", collection, doc_id, e)
            self._cloud_available = False
            return fallback_res

    def list_documents(self, collection: str, prefix: str = "") -> List[Dict[str, Any]]:
        if not self._cloud_available:
            return self._fallback.list_documents(collection, prefix)
        try:
            coll_ref = self._db.collection(collection)
            if not prefix:
                docs = coll_ref.stream()
                cloud_docs = [d.to_dict() for d in docs]
            else:
                end_prefix = prefix[:-1] + chr(ord(prefix[-1]) + 1) if prefix else "\uf8ff"
                docs = coll_ref.where("__name__", ">=", prefix).where("__name__", "<", end_prefix).stream()
                cloud_docs = [d.to_dict() for d in docs]
            mem_docs = self._fallback.list_documents(collection, prefix)
            merged = {d.get("id", str(i)): d for i, d in enumerate(mem_docs)}
            for d in cloud_docs:
                if "id" in d:
                    merged[d["id"]] = d
            return list(merged.values()) if merged else cloud_docs
        except Exception as e:
            logger.warning("Firestore list_documents failed for %s, falling back to memory store: %s", collection, e)
            self._cloud_available = False
            return self._fallback.list_documents(collection, prefix)


def _init_firestore_client() -> Optional[Any]:
    enable_firebase = os.environ.get("ENABLE_FIREBASE", "true").strip().lower()
    if enable_firebase in ("false", "0", "no"):
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        app_name = os.environ.get("FIREBASE_APP_NAME", "mindpal").strip() or "mindpal"
        if app_name in firebase_admin._apps:
            app = firebase_admin.get_app(app_name)
        else:
            raw_json = os.environ.get("FIREBASE_CREDENTIALS_JSON", "").strip()
            cred = None
            if raw_json:
                data = json.loads(raw_json)
                private_key = str(data.get("private_key", ""))
                if "\\n" in private_key:
                    data["private_key"] = private_key.replace("\\n", "\n")
                cred = credentials.Certificate(data)
            else:
                cred_path = (
                    os.environ.get("FIREBASE_CREDENTIALS_PATH", "").strip()
                    or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
                )
                if cred_path and Path(cred_path).exists():
                    cred = credentials.Certificate(cred_path)
                elif Path("firebase-credentials-minified.json").exists():
                    cred = credentials.Certificate("firebase-credentials-minified.json")
                else:
                    cred = credentials.ApplicationDefault()

            project_id = (
                os.environ.get("FIREBASE_PROJECT_ID", "").strip()
                or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
                or "mindpal-official-0"
            )
            app = firebase_admin.initialize_app(cred, {"projectId": project_id}, name=app_name)

        database_id = os.environ.get("FIRESTORE_DATABASE_ID", "").strip() or "(default)"
        if database_id in ("(default)", "default"):
            return firestore.client(app=app)
        return firestore.client(app=app, database_id=database_id)
    except Exception as e:
        logger.warning("Cloud Firestore client initialization fallback: %s", e)
        return None


_client = _init_firestore_client()
_GLOBAL_STORE: DocumentStore = FirestoreStore(_client) if _client is not None else InMemoryStore()


def get_store() -> DocumentStore:
    return _GLOBAL_STORE
