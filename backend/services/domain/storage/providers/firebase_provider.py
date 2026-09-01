# Firebase storage provider

from __future__ import annotations

import asyncio
import json
import logging
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from backend.core.config import Settings, get_settings
from backend.core.errors import DatabaseError
from backend.core.logging import log_event
from backend.core.security import sanitize_text
from backend.core.settings_helpers import setting_bool, setting_str

logger = logging.getLogger("mindpal.storage.firebase")


MAX_COLLECTION_CHARS = 80
MAX_DOCUMENT_KEY_CHARS = 180
MAX_EVENTS_PER_KIND = 5_000


class FirebaseDBProvider:
    """Firestore provider for production storage."""

    name = "firebase"

    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.project_id = _firebase_project_id(self.settings)
        self.database_id = _firestore_database_id(self.settings)
        self._client: Any | None = None
        self._init_error: str | None = None

        try:
            self._client = self._build_client()
            log_event(logger, "firebase_client_initialized", project_id=sanitize_text(str(self.project_id), 100))
        except Exception as exc:
            self._init_error = f"{exc.__class__.__name__}: {sanitize_text(str(exc), 500)}"
            self._client = None
            log_event(
                logger,
                "firebase_client_initialization_failed",
                error_type=exc.__class__.__name__,
                error_message=sanitize_text(str(exc), 500),
                project_id=sanitize_text(str(self.project_id), 100),
            )

    @property
    def is_configured(self) -> bool:
        return self._client is not None

    @property
    def init_error(self) -> str | None:
        return self._init_error

    def _require_client(self) -> Any:
        if self._client is None:
            raise RuntimeError("Firebase database provider is not initialized")
        return self._client

    def _build_client(self) -> Any:
        try:
            import firebase_admin
            from firebase_admin import firestore
        except Exception as exc:
            raise RuntimeError("firebase-admin is not installed") from exc

        if not self.project_id:
            raise RuntimeError("Missing FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT")

        app_name = setting_str(self.settings, "FIREBASE_APP_NAME", "mindpal") or "mindpal"
        app = firebase_admin.get_app(app_name) if app_name in firebase_admin._apps else firebase_admin.initialize_app(
            _firebase_credentials(self.settings, expected_project_id=self.project_id),
            {"projectId": self.project_id},
            name=app_name,
        )

        return firestore.client(app=app, database_id=self.database_id)

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        def _read() -> dict[str, Any] | None:
            client = self._require_client()
            snap = client.collection(collection).document(key).get()
            if not snap.exists:
                return None
            return deepcopy(snap.to_dict() or {})

        return await asyncio.to_thread(_read)

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        clean_payload = deepcopy(payload)

        def _write() -> None:
            client = self._require_client()
            client.collection(collection).document(key).set(clean_payload)

        await asyncio.to_thread(_write)

    async def delete_document(self, collection: str, key: str) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        def _delete() -> None:
            client = self._require_client()
            client.collection(collection).document(key).delete()

        await asyncio.to_thread(_delete)

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        collection = _clean_collection(collection)
        clean_payload = deepcopy(payload)

        def _append() -> str:
            client = self._require_client()
            doc_ref = client.collection(collection).document()
            event_id = doc_ref.id
            event_payload = {"event_id": event_id, "created_at": _utcnow_iso(), **clean_payload}
            doc_ref.set(event_payload)
            return event_id

        return await asyncio.to_thread(_append)

    async def atomic_update_document(
        self,
        collection: str,
        key: str,
        update_fn: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        def _tx() -> dict[str, Any]:
            client = self._require_client()
            from firebase_admin import firestore
            transaction = client.transaction()
            doc_ref = client.collection(collection).document(key)

            @firestore.transactional
            def update_in_transaction(transaction: Any, doc_ref: Any) -> dict[str, Any]:
                snapshot = doc_ref.get(transaction=transaction)
                data = snapshot.to_dict() or {} if snapshot.exists else {}
                updated_data = update_fn(deepcopy(data))
                transaction.set(doc_ref, deepcopy(updated_data))
                return updated_data

            return update_in_transaction(transaction, doc_ref)

        return await asyncio.to_thread(_tx)


class InMemoryDBProvider:
    """Simple in-memory fallback for local dev/testing."""

    name = "mock"

    def __init__(self) -> None:
        self._documents: dict[str, dict[str, dict[str, Any]]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    @property
    def is_configured(self) -> bool:
        return True

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        async with self._lock:
            payload = self._documents.get(collection, {}).get(key)
            return deepcopy(payload) if payload is not None else None

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        async with self._lock:
            self._documents.setdefault(collection, {})[key] = deepcopy(payload)

    async def delete_document(self, collection: str, key: str) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        async with self._lock:
            self._documents.get(collection, {}).pop(key, None)

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        collection = _clean_collection(collection)
        async with self._lock:
            event_id = f"evt_{len(self._events.get(collection, [])) + 1}"
            event_payload = {"event_id": event_id, "created_at": _utcnow_iso(), **deepcopy(payload)}
            self._events.setdefault(collection, []).append(event_payload)
            if len(self._events[collection]) > MAX_EVENTS_PER_KIND:
                self._events[collection] = self._events[collection][-MAX_EVENTS_PER_KIND:]
            return event_id

    async def atomic_update_document(
        self,
        collection: str,
        key: str,
        update_fn: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        async with self._lock:
            current = self._documents.get(collection, {}).get(key, {})
            updated = update_fn(deepcopy(current))
            self._documents.setdefault(collection, {})[key] = deepcopy(updated)
            return deepcopy(updated)


class UnavailableDBProvider:
    """Fail-closed provider used when production Firebase is unavailable."""

    name = "firebase_unavailable"

    def __init__(self, *, reason: str | None = None) -> None:
        self.reason = sanitize_text(str(reason or "Firebase provider unavailable"), 500)

    @property
    def is_configured(self) -> bool:
        return False

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        raise self._error("get_document")

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        raise self._error("set_document")

    async def delete_document(self, collection: str, key: str) -> None:
        raise self._error("delete_document")

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        raise self._error("append_event")

    async def atomic_update_document(
        self,
        collection: str,
        key: str,
        update_fn: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        raise self._error("atomic_update_document")

    def _error(self, operation: str) -> DatabaseError:
        return DatabaseError(
            "Firebase database provider is unavailable",
            code="db_provider_unavailable",
            details={"provider": self.name, "operation": sanitize_text(operation, 80), "reason": self.reason},
        )


def _firebase_project_id(settings: Settings) -> str:
    return (
        setting_str(settings, "FIREBASE_PROJECT_ID")
        or setting_str(settings, "GOOGLE_CLOUD_PROJECT")
    ) or ""


def _firestore_database_id(settings: Settings) -> str:
    return setting_str(settings, "FIRESTORE_DATABASE_ID", "default") or "default"


def _firebase_credentials(settings: Settings, *, expected_project_id: str) -> Any:
    try:
        from firebase_admin import credentials
    except Exception as exc:
        raise RuntimeError("firebase-admin credentials module is unavailable") from exc

    raw_json = setting_str(settings, "FIREBASE_CREDENTIALS_JSON")
    credentials_path = (
        setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
    )
    use_adc = setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)

    if raw_json:
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_CREDENTIALS_JSON is not valid JSON") from exc

        actual_project_id = sanitize_text(str(data.get("project_id") or ""), 160)
        if expected_project_id and actual_project_id and actual_project_id != expected_project_id:
            raise RuntimeError("Firebase credentials project_id does not match FIREBASE_PROJECT_ID")

        private_key = str(data.get("private_key", ""))
        if "\\n" in private_key:
            data["private_key"] = private_key.replace("\\n", "\n")
        return credentials.Certificate(data)

    if credentials_path:
        path = Path(credentials_path)
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise RuntimeError(f"Firebase credentials file not found: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Firebase credentials file is not valid JSON: {path}") from exc

        actual_project_id = sanitize_text(str(data.get("project_id") or ""), 160)
        if expected_project_id and actual_project_id and actual_project_id != expected_project_id:
            raise RuntimeError("Firebase credentials project_id does not match FIREBASE_PROJECT_ID")
        return credentials.Certificate(data)

    if use_adc:
        return credentials.ApplicationDefault()

    raise RuntimeError("Missing Firebase credentials. Set FIREBASE_CREDENTIALS_JSON, FIREBASE_CREDENTIALS_PATH, or FIREBASE_USE_APPLICATION_DEFAULT=true.")


def _clean_collection(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_COLLECTION_CHARS)
    if not cleaned:
        raise DatabaseError("Collection name cannot be empty", code="db_invalid_collection")
    return cleaned


def _clean_key(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_DOCUMENT_KEY_CHARS)
    if not cleaned:
        raise DatabaseError("Document key cannot be empty", code="db_invalid_key")
    return cleaned


def _utcnow_iso() -> str:
    return datetime.now(UTC).isoformat()
