# backend/services/db_service.py

from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import DatabaseError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.models.memory import (
    MemoryGraph,
    MemoryGraphLoadResult,
    MemoryGraphWriteResult,
    MemoryLoadResult,
    MemorySource,
    MemorySummary,
    MemoryWriteResult,
)
from backend.models.safety import SafetyEvent
from backend.models.user import (
    UserProfile,
    UserProfileResponse,
    UserProfileUpdate,
)


MAX_DOCUMENT_KEY_CHARS = 180
MAX_COLLECTION_CHARS = 80
MAX_EVENT_KIND_CHARS = 80
MAX_EVENTS_PER_KIND = 5_000


class DBProvider(Protocol):
    """
    Storage provider protocol.

    Implementations:
    - FirebaseDBProvider: production Firestore provider
    - InMemoryDBProvider: local/test/offline fallback
    - UnavailableDBProvider: fail-closed production provider
    """

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        ...

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        ...

    async def delete_document(self, collection: str, key: str) -> None:
        ...

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        ...


class InMemoryDBProvider:
    """
    Safe local/mock database provider.

    Intended for:
    - local development without Firebase credentials
    - tests
    - offline demo mode

    This provider is process-local and not durable. It must not be used as a
    silent fallback in production.
    """

    name = "mock"

    def __init__(self) -> None:
        self._documents: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
        self._events: dict[str, list[dict[str, Any]]] = defaultdict(list)
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
            self._documents[collection][key] = deepcopy(payload)

    async def delete_document(self, collection: str, key: str) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        async with self._lock:
            self._documents.get(collection, {}).pop(key, None)

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        collection = _clean_collection(collection)

        async with self._lock:
            event_id = f"evt_{len(self._events[collection]) + 1}"
            event_payload = {
                "event_id": event_id,
                "created_at": _utcnow_iso(),
                **deepcopy(payload),
            }

            self._events[collection].append(event_payload)

            if len(self._events[collection]) > MAX_EVENTS_PER_KIND:
                self._events[collection] = self._events[collection][-MAX_EVENTS_PER_KIND:]

            return event_id

    async def list_events(self, collection: str) -> list[dict[str, Any]]:
        collection = _clean_collection(collection)

        async with self._lock:
            return deepcopy(self._events.get(collection, []))


class UnavailableDBProvider:
    """
    Fail-closed provider used when production Firebase initialization fails.

    This prevents production from silently writing user memory/profile data into
    process-local mock storage.
    """

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

    def _error(self, operation: str) -> DatabaseError:
        return DatabaseError(
            "Firebase database provider is unavailable",
            code="db_provider_unavailable",
            details={
                "provider": self.name,
                "operation": sanitize_text(operation, 80),
                "reason": self.reason,
            },
        )


class FirebaseDBProvider:
    """
    Firebase Firestore provider.

    Uses explicit FIRESTORE_DATABASE_ID because this project created a Firestore
    database with database ID "default", while Firestore Admin SDK may otherwise
    try the legacy implicit "(default)" database.
    """

    name = "firebase"

    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.project_id = _firebase_project_id(self.settings)
        self.database_id = _firestore_database_id(self.settings)
        self._client: Any | None = None
        self._init_error: str | None = None

        try:
            self._client = self._build_client()
        except Exception as exc:
            self._init_error = f"{exc.__class__.__name__}: {sanitize_text(str(exc), 500)}"
            self._client = None

    @property
    def is_configured(self) -> bool:
        return self._client is not None

    @property
    def init_error(self) -> str | None:
        return self._init_error

    def _build_client(self) -> Any:
        try:
            import firebase_admin
            from firebase_admin import firestore
        except Exception as exc:
            raise RuntimeError("firebase-admin is not installed") from exc

        if not self.project_id:
            raise RuntimeError("Missing FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT")

        app_name = _setting_str(self.settings, "FIREBASE_APP_NAME", "mindpal") or "mindpal"

        if app_name in firebase_admin._apps:
            app = firebase_admin.get_app(app_name)
        else:
            app = firebase_admin.initialize_app(
                _firebase_credentials(self.settings, expected_project_id=self.project_id),
                {"projectId": self.project_id},
                name=app_name,
            )

        return firestore.client(app=app, database_id=self.database_id)

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        def _read() -> dict[str, Any] | None:
            assert self._client is not None
            snap = self._client.collection(collection).document(key).get()
            if not snap.exists:
                return None
            return deepcopy(snap.to_dict() or {})

        return await asyncio.to_thread(_read)

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)
        clean_payload = deepcopy(payload)

        def _write() -> None:
            assert self._client is not None
            self._client.collection(collection).document(key).set(clean_payload)

        await asyncio.to_thread(_write)

    async def delete_document(self, collection: str, key: str) -> None:
        collection = _clean_collection(collection)
        key = _clean_key(key)

        def _delete() -> None:
            assert self._client is not None
            self._client.collection(collection).document(key).delete()

        await asyncio.to_thread(_delete)

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        collection = _clean_collection(collection)
        clean_payload = deepcopy(payload)

        def _append() -> str:
            assert self._client is not None
            doc_ref = self._client.collection(collection).document()
            event_id = doc_ref.id
            event_payload = {
                "event_id": event_id,
                "created_at": _utcnow_iso(),
                **clean_payload,
            }
            doc_ref.set(event_payload)
            return event_id

        return await asyncio.to_thread(_append)


class DBService:
    """
    Database boundary service.

    Responsibilities:
    - use Firebase Firestore when configured
    - allow in-memory DB only outside production
    - fail closed in production when Firebase is unavailable
    - persist sanitized memory summaries
    - persist sanitized user profiles
    - append sanitized safety events
    - never log/store raw chat messages by default

    Non-responsibilities:
    - auth/session resolution
    - LLM calls
    - safety classification
    - memory compaction
    """

    MEMORY_COLLECTION = "memory_summaries"
    MEMORY_GRAPH_COLLECTION = "memory_graphs"
    USER_COLLECTION = "user_profiles"
    SAFETY_EVENTS_COLLECTION = "safety_events"

    def __init__(
        self,
        *,
        provider: DBProvider | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.production_mode = _is_production(self.settings)
        self.firebase_init_error: str | None = None

        if provider is not None and provider.is_configured:
            self.provider: DBProvider = provider
            self.mock_mode = False
            return

        firebase_provider = FirebaseDBProvider(settings=self.settings)

        if firebase_provider.is_configured:
            self.provider = firebase_provider
            self.mock_mode = False
            return

        self.firebase_init_error = firebase_provider.init_error

        if self.production_mode:
            self.provider = UnavailableDBProvider(reason=self.firebase_init_error)
            self.mock_mode = False
            return

        self.provider = InMemoryDBProvider()
        self.mock_mode = True

    async def load_memory(self, user_id_hash: str) -> MemoryLoadResult:
        user_id_hash = _clean_key(user_id_hash)

        try:
            payload = await self.provider.get_document(self.MEMORY_COLLECTION, user_id_hash)

            if not payload:
                return MemoryLoadResult(
                    user_id_hash=user_id_hash,
                    loaded=False,
                    source=MemorySource.UNKNOWN,
                    summary=None,
                )

            summary = MemorySummary.model_validate(payload)

            return MemoryLoadResult(
                user_id_hash=user_id_hash,
                loaded=True,
                source=summary.source,
                summary=summary,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to load memory summary",
                code="db_memory_load_failed",
                details={"provider": self.provider.name},
            ) from exc

    async def save_memory(self, summary: MemorySummary) -> MemoryWriteResult:
        try:
            clean_summary = _sanitize_memory_summary(summary)
            payload = clean_summary.model_dump(mode="json")

            await self.provider.set_document(
                self.MEMORY_COLLECTION,
                clean_summary.user_id_hash,
                payload,
            )

            return MemoryWriteResult(
                user_id_hash=clean_summary.user_id_hash,
                saved=True,
                provider=self.provider.name,
                memory_updated=True,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(summary, "user_id_hash", "unknown")

            raise DatabaseError(
                "Failed to save memory summary",
                code="db_memory_save_failed",
                details={
                    "provider": self.provider.name,
                    "user_id_hash": sanitize_text(str(user_id_hash), 80),
                },
            ) from exc

    async def delete_memory(self, user_id_hash: str) -> MemoryWriteResult:
        user_id_hash = _clean_key(user_id_hash)

        try:
            await self.provider.delete_document(self.MEMORY_COLLECTION, user_id_hash)

            return MemoryWriteResult(
                user_id_hash=user_id_hash,
                saved=True,
                provider=self.provider.name,
                memory_updated=True,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to delete memory summary",
                code="db_memory_delete_failed",
                details={"provider": self.provider.name, "user_id_hash": user_id_hash},
            ) from exc

    async def load_memory_graph(self, user_id_hash: str) -> MemoryGraphLoadResult:
        user_id_hash = _clean_key(user_id_hash)

        try:
            payload = await self.provider.get_document(self.MEMORY_GRAPH_COLLECTION, user_id_hash)

            if not payload:
                return MemoryGraphLoadResult(
                    user_id_hash=user_id_hash,
                    loaded=False,
                    graph=None,
                    provider=self.provider.name,
                )

            graph = MemoryGraph.model_validate(payload)
            return MemoryGraphLoadResult(
                user_id_hash=user_id_hash,
                loaded=True,
                graph=graph,
                provider=self.provider.name,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to load memory graph",
                code="db_memory_graph_load_failed",
                details={"provider": self.provider.name, "user_id_hash": user_id_hash},
            ) from exc

    async def save_memory_graph(self, graph: MemoryGraph) -> MemoryGraphWriteResult:
        try:
            clean_graph = graph.model_copy(update={"user_id_hash": _clean_key(graph.user_id_hash)})
            payload = clean_graph.model_dump(mode="json")

            await self.provider.set_document(
                self.MEMORY_GRAPH_COLLECTION,
                clean_graph.user_id_hash,
                payload,
            )

            return MemoryGraphWriteResult(
                user_id_hash=clean_graph.user_id_hash,
                saved=True,
                provider=self.provider.name,
                memory_updated=True,
                version=clean_graph.version,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(graph, "user_id_hash", "unknown")
            raise DatabaseError(
                "Failed to save memory graph",
                code="db_memory_graph_save_failed",
                details={
                    "provider": self.provider.name,
                    "user_id_hash": sanitize_text(str(user_id_hash), 80),
                },
            ) from exc

    async def delete_memory_graph(self, user_id_hash: str) -> MemoryGraphWriteResult:
        user_id_hash = _clean_key(user_id_hash)

        try:
            await self.provider.delete_document(self.MEMORY_GRAPH_COLLECTION, user_id_hash)
            return MemoryGraphWriteResult(
                user_id_hash=user_id_hash,
                saved=True,
                provider=self.provider.name,
                memory_updated=True,
                version=1,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to delete memory graph",
                code="db_memory_graph_delete_failed",
                details={"provider": self.provider.name, "user_id_hash": user_id_hash},
            ) from exc

    async def load_user_profile(self, user_id_hash: str) -> UserProfileResponse:
        user_id_hash = _clean_key(user_id_hash)

        try:
            payload = await self.provider.get_document(self.USER_COLLECTION, user_id_hash)

            if not payload:
                return UserProfileResponse(
                    profile=UserProfile(user_id_hash=user_id_hash),
                    loaded=False,
                    provider=self.provider.name,
                )

            return UserProfileResponse(
                profile=UserProfile.model_validate(payload),
                loaded=True,
                provider=self.provider.name,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to load user profile",
                code="db_user_profile_load_failed",
                details={"provider": self.provider.name, "user_id_hash": user_id_hash},
            ) from exc

    async def save_user_profile(self, profile: UserProfile) -> UserProfileResponse:
        try:
            clean_profile = _sanitize_user_profile(profile)
            payload = clean_profile.model_dump(mode="json")

            await self.provider.set_document(
                self.USER_COLLECTION,
                clean_profile.user_id_hash,
                payload,
            )

            return UserProfileResponse(
                profile=clean_profile,
                loaded=True,
                provider=self.provider.name,
            )

        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(profile, "user_id_hash", "unknown")

            raise DatabaseError(
                "Failed to save user profile",
                code="db_user_profile_save_failed",
                details={
                    "provider": self.provider.name,
                    "user_id_hash": sanitize_text(str(user_id_hash), 80),
                },
            ) from exc

    async def update_user_profile(
        self,
        user_id_hash: str,
        update: UserProfileUpdate,
    ) -> UserProfileResponse:
        current = await self.load_user_profile(user_id_hash)
        profile = current.profile

        updated = UserProfile(
            user_id_hash=profile.user_id_hash,
            status=profile.status,
            channel=profile.channel,
            preferences=update.preferences or profile.preferences,
            notes=update.notes if update.notes is not None else profile.notes,
            metadata=update.metadata if update.metadata is not None else profile.metadata,
            created_at=profile.created_at,
            updated_at=datetime.now(UTC),
        )

        return await self.save_user_profile(updated)

    async def append_safety_event(self, event: SafetyEvent) -> str:
        """
        Append sanitized safety event metadata.

        This intentionally stores rule IDs and decision metadata only.
        It does not store raw user text.
        """
        try:
            payload = event.model_dump(mode="json")
            payload = _sanitize_payload(payload)

            return await self.provider.append_event(self.SAFETY_EVENTS_COLLECTION, payload)

        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError(
                "Failed to append safety event",
                code="db_safety_event_append_failed",
                details={"provider": self.provider.name},
            ) from exc

    async def health(self) -> dict[str, Any]:
        return {
            "provider": self.provider.name,
            "provider_configured": bool(self.provider.is_configured),
            "mock_mode": self.mock_mode,
            "production_mode": self.production_mode,
            "stores_raw_chat_by_default": False,
            "firebase_required": self.production_mode or _firebase_env_present(self.settings),
            "firebase_init_error": self.firebase_init_error,
            "project_id": getattr(self.provider, "project_id", None),
            "database_id": getattr(self.provider, "database_id", None),
            "collections": [
                self.MEMORY_COLLECTION,
                self.USER_COLLECTION,
                self.SAFETY_EVENTS_COLLECTION,
            ],
        }


def _setting_value(settings: Settings, name: str, default: Any = None) -> Any:
    value = getattr(settings, name, None)

    if value is None:
        return os.getenv(name, default)

    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    return value


def _setting_str(settings: Settings, name: str, default: str = "") -> str:
    value = _setting_value(settings, name, default)
    return sanitize_text(str(value or ""), 1_000)


def _setting_secret_str(settings, name, default=""):
    value = _setting_value(settings, name, default)

    if value is None:
        return default

    if hasattr(value, "get_secret_value"):
        value = value.get_secret_value()

    return str(value or default).strip()

def _setting_bool(settings: Settings, name: str, *, default: bool) -> bool:
    value = _setting_value(settings, name, None)

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _is_production(settings: Settings) -> bool:
    environment = _setting_str(settings, "ENVIRONMENT", "development").lower()
    return environment in {"production", "prod"}


def _firebase_project_id(settings: Settings) -> str:
    return (
        _setting_str(settings, "FIREBASE_PROJECT_ID")
        or _setting_str(settings, "GOOGLE_CLOUD_PROJECT")
    )


def _firestore_database_id(settings: Settings) -> str:
    return _setting_str(settings, "FIRESTORE_DATABASE_ID", "default") or "default"


def _firebase_env_present(settings: Settings) -> bool:
    return bool(
        _setting_str(settings, "FIREBASE_CREDENTIALS_JSON")
        or _setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or _setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
        or _setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)
    )


def _firebase_credentials(settings: Settings, *, expected_project_id: str) -> Any:
    try:
        from firebase_admin import credentials
    except Exception as exc:
        raise RuntimeError("firebase-admin credentials module is unavailable") from exc

    raw_json = _setting_secret_str(settings, "FIREBASE_CREDENTIALS_JSON")
    credentials_path = (
        _setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or _setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
    )
    use_adc = _setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)

    if raw_json:
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_CREDENTIALS_JSON is not valid JSON") from exc

        actual_project_id = sanitize_text(str(data.get("project_id") or ""), 160)

        if expected_project_id and actual_project_id and actual_project_id != expected_project_id:
            raise RuntimeError(
                "Firebase credentials project_id does not match FIREBASE_PROJECT_ID"
            )

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
            raise RuntimeError(
                "Firebase credentials project_id does not match FIREBASE_PROJECT_ID"
            )

        return credentials.Certificate(data)

    if use_adc:
        return credentials.ApplicationDefault()

    raise RuntimeError(
        "Missing Firebase credentials. Set FIREBASE_CREDENTIALS_JSON, "
        "FIREBASE_CREDENTIALS_PATH, or FIREBASE_USE_APPLICATION_DEFAULT=true."
    )


def _sanitize_memory_summary(summary: MemorySummary) -> MemorySummary:
    payload = _sanitize_payload(summary.model_dump(mode="json"))
    return MemorySummary.model_validate(payload)


def _sanitize_user_profile(profile: UserProfile) -> UserProfile:
    payload = _sanitize_payload(profile.model_dump(mode="json"))
    return UserProfile.model_validate(payload)


def _sanitize_payload(payload: Any) -> Any:
    if payload is None or isinstance(payload, (bool, int, float)):
        return payload

    if isinstance(payload, str):
        return redact_basic_pii(sanitize_text(payload, 5_000))

    if isinstance(payload, list):
        return [_sanitize_payload(item) for item in payload]

    if isinstance(payload, dict):
        return {
            sanitize_text(str(key), 120): _sanitize_payload(value)
            for key, value in payload.items()
            if sanitize_text(str(key), 120)
        }

    return redact_basic_pii(sanitize_text(str(payload), 5_000))


def _clean_collection(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_COLLECTION_CHARS)

    if not cleaned:
        raise DatabaseError(
            "Collection name cannot be empty",
            code="db_invalid_collection",
        )

    return cleaned


def _clean_key(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), MAX_DOCUMENT_KEY_CHARS)

    if not cleaned:
        raise DatabaseError(
            "Document key cannot be empty",
            code="db_invalid_key",
        )

    return cleaned


def _utcnow_iso() -> str:
    return datetime.now(UTC).isoformat()
