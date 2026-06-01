# backend/services/db_service.py

from __future__ import annotations

import asyncio
from collections import defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from backend.core.config import Settings, get_settings
from backend.core.errors import DatabaseError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.models.memory import (
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

    Firebase provider later should implement this interface. This service does
    not import Firebase modules directly, so local/mock mode remains reliable
    when Firebase credentials are missing.
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
    - development
    - tests
    - missing Firebase config
    - offline demo mode

    This provider is process-local and not durable.
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


class DBService:
    """
    Database boundary service.

    Responsibilities:
    - choose mock mode when provider/Firebase is unavailable
    - persist sanitized memory summaries
    - persist sanitized user profiles
    - append sanitized safety events
    - never require Firebase at startup
    - never log/store raw chat messages by default

    Non-responsibilities:
    - auth/session resolution
    - LLM calls
    - safety classification
    - memory compaction
    """

    MEMORY_COLLECTION = "memory_summaries"
    USER_COLLECTION = "user_profiles"
    SAFETY_EVENTS_COLLECTION = "safety_events"

    def __init__(
        self,
        *,
        provider: DBProvider | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()

        if provider is not None and provider.is_configured:
            self.provider: DBProvider = provider
            self.mock_mode = False
        else:
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

        except Exception as exc:
            raise DatabaseError(
                "Failed to delete memory summary",
                code="db_memory_delete_failed",
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

        This intentionally stores rule IDs and decision metadata only. It does
        not store raw user text.
        """
        try:
            payload = event.model_dump(mode="json")
            payload = _sanitize_payload(payload)

            return await self.provider.append_event(self.SAFETY_EVENTS_COLLECTION, payload)

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
            "stores_raw_chat_by_default": False,
            "firebase_required": False,
            "collections": [
                self.MEMORY_COLLECTION,
                self.USER_COLLECTION,
                self.SAFETY_EVENTS_COLLECTION,
            ],
        }


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