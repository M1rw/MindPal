# Storage domain service

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Callable

from backend.core.config import Settings, get_settings
from backend.core.errors import DatabaseError
from backend.core.security import redact_basic_pii, sanitize_text
from backend.core.settings_helpers import is_production, setting_bool, setting_str
from backend.models.memory import MemoryGraph, MemoryGraphLoadResult, MemoryGraphWriteResult, MemoryLoadResult, MemorySource, MemorySummary, MemoryWriteResult
from backend.models.safety import SafetyEvent
from backend.models.user import UserProfile, UserProfileResponse, UserProfileUpdate

from .models import StorageHealth
from .protocols import StorageProvider
from .providers import FirebaseDBProvider, InMemoryDBProvider, UnavailableDBProvider


class StorageService:
    """Business-focused storage boundary service."""

    MEMORY_COLLECTION = "memory_summaries"
    MEMORY_GRAPH_COLLECTION = "memory_graphs"
    USER_COLLECTION = "user_profiles"
    SAFETY_EVENTS_COLLECTION = "safety_events"

    def __init__(self, *, provider: StorageProvider | None = None, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.production_mode = is_production(self.settings)
        self.firebase_init_error: str | None = None

        if provider is not None and provider.is_configured:
            self.provider: StorageProvider = provider
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

        # In development, fall back to in-memory provider
        self.provider = InMemoryDBProvider()
        self.mock_mode = True

    async def load_memory(self, user_id_hash: str) -> MemoryLoadResult:
        user_id_hash = _clean_key(user_id_hash)
        try:
            payload = await self.provider.get_document(self.MEMORY_COLLECTION, user_id_hash)
            if not payload:
                return MemoryLoadResult(user_id_hash=user_id_hash, loaded=False, source=MemorySource.UNKNOWN, summary=None)
            return MemoryLoadResult(
                user_id_hash=user_id_hash,
                loaded=True,
                source=MemorySummary.model_validate(payload).source,
                summary=MemorySummary.model_validate(payload),
            )
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to load memory summary", code="db_memory_load_failed", details={"provider": self.provider.name}) from exc

    async def save_memory(self, summary: MemorySummary) -> MemoryWriteResult:
        try:
            clean_summary = _sanitize_memory_summary(summary)
            await self.provider.set_document(self.MEMORY_COLLECTION, clean_summary.user_id_hash, clean_summary.model_dump(mode="json"))
            return MemoryWriteResult(user_id_hash=clean_summary.user_id_hash, saved=True, provider=self.provider.name, memory_updated=True)
        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(summary, "user_id_hash", "unknown")
            raise DatabaseError("Failed to save memory summary", code="db_memory_save_failed", details={"provider": self.provider.name, "user_id_hash": sanitize_text(str(user_id_hash), 80)}) from exc

    async def delete_memory(self, user_id_hash: str) -> MemoryWriteResult:
        user_id_hash = _clean_key(user_id_hash)
        try:
            await self.provider.delete_document(self.MEMORY_COLLECTION, user_id_hash)
            return MemoryWriteResult(user_id_hash=user_id_hash, saved=True, provider=self.provider.name, memory_updated=True)
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to delete memory summary", code="db_memory_delete_failed", details={"provider": self.provider.name, "user_id_hash": user_id_hash}) from exc

    async def load_memory_graph(self, user_id_hash: str) -> MemoryGraphLoadResult:
        user_id_hash = _clean_key(user_id_hash)
        try:
            payload = await self.provider.get_document(self.MEMORY_GRAPH_COLLECTION, user_id_hash)
            if not payload:
                return MemoryGraphLoadResult(user_id_hash=user_id_hash, loaded=False, graph=None, provider=self.provider.name)
            graph = MemoryGraph.model_validate(payload)
            return MemoryGraphLoadResult(user_id_hash=user_id_hash, loaded=True, graph=graph, provider=self.provider.name)
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to load memory graph", code="db_memory_graph_load_failed", details={"provider": self.provider.name, "user_id_hash": user_id_hash}) from exc

    async def save_memory_graph(self, graph: MemoryGraph) -> MemoryGraphWriteResult:
        try:
            clean_graph = graph.model_copy(update={"user_id_hash": _clean_key(graph.user_id_hash)})
            await self.provider.set_document(self.MEMORY_GRAPH_COLLECTION, clean_graph.user_id_hash, clean_graph.model_dump(mode="json"))
            return MemoryGraphWriteResult(user_id_hash=clean_graph.user_id_hash, saved=True, provider=self.provider.name, memory_updated=True, version=clean_graph.version)
        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(graph, "user_id_hash", "unknown")
            raise DatabaseError("Failed to save memory graph", code="db_memory_graph_save_failed", details={"provider": self.provider.name, "user_id_hash": sanitize_text(str(user_id_hash), 80)}) from exc

    async def load_user_profile(self, user_id_hash: str) -> UserProfileResponse:
        user_id_hash = _clean_key(user_id_hash)
        try:
            payload = await self.provider.get_document(self.USER_COLLECTION, user_id_hash)
            if not payload:
                return UserProfileResponse(profile=UserProfile(user_id_hash=user_id_hash), loaded=False, provider=self.provider.name)
            return UserProfileResponse(profile=UserProfile.model_validate(payload), loaded=True, provider=self.provider.name)
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to load user profile", code="db_user_profile_load_failed", details={"provider": self.provider.name, "user_id_hash": user_id_hash}) from exc

    async def save_user_profile(self, profile: UserProfile) -> UserProfileResponse:
        try:
            clean_profile = _sanitize_user_profile(profile)
            await self.provider.set_document(self.USER_COLLECTION, clean_profile.user_id_hash, clean_profile.model_dump(mode="json"))
            return UserProfileResponse(profile=clean_profile, loaded=True, provider=self.provider.name)
        except DatabaseError:
            raise
        except Exception as exc:
            user_id_hash = getattr(profile, "user_id_hash", "unknown")
            raise DatabaseError("Failed to save user profile", code="db_user_profile_save_failed", details={"provider": self.provider.name, "user_id_hash": sanitize_text(str(user_id_hash), 80)}) from exc

    async def update_user_profile(self, user_id_hash: str, update: UserProfileUpdate) -> UserProfileResponse:
        def apply(profile: UserProfile) -> UserProfile:
            new_preferences = profile.preferences
            if update.preferences is not None:
                new_preferences = profile.preferences.model_copy(update=update.preferences.model_dump(exclude_unset=True))

            new_clinical = profile.clinical
            if update.clinical is not None:
                new_clinical = profile.clinical.model_copy(update=update.clinical.model_dump(exclude_unset=True))

            return profile.model_copy(
                update={
                    "preferences": new_preferences,
                    "clinical": new_clinical,
                    "notes": update.notes if update.notes is not None else profile.notes,
                    "metadata": update.metadata if update.metadata is not None else profile.metadata,
                }
            )

        return await self.atomic_update_user_profile(user_id_hash, apply)

    async def atomic_update_user_profile(self, user_id_hash: str, update_fn: Callable[[UserProfile], UserProfile]) -> UserProfileResponse:
        user_id_hash = _clean_key(user_id_hash)
        try:
            def dict_updater(data: dict[str, Any]) -> dict[str, Any]:
                profile = UserProfile(user_id_hash=user_id_hash) if not data else UserProfile.model_validate(data)
                updated_profile = update_fn(profile)
                updated_profile = _sanitize_user_profile(updated_profile)
                return updated_profile.model_dump(mode="json")

            updated_data = await self.provider.atomic_update_document(self.USER_COLLECTION, user_id_hash, dict_updater)
            return UserProfileResponse(profile=UserProfile.model_validate(updated_data), loaded=True, provider=self.provider.name)
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to atomically update user profile", code="db_user_profile_atomic_update_failed", details={"provider": self.provider.name, "user_id_hash": user_id_hash}) from exc

    async def append_safety_event(self, event: SafetyEvent) -> str:
        try:
            payload = _sanitize_payload(event.model_dump(mode="json"))
            return await self.provider.append_event(self.SAFETY_EVENTS_COLLECTION, payload)
        except DatabaseError:
            raise
        except Exception as exc:
            raise DatabaseError("Failed to append safety event", code="db_safety_event_append_failed", details={"provider": self.provider.name}) from exc

    async def health(self) -> dict[str, Any]:
        return asdict(
            StorageHealth(
                provider=self.provider.name,
                configured=bool(self.provider.is_configured),
                mock_mode=self.mock_mode,
                production_mode=self.production_mode,
                firebase_required=self.production_mode or _firebase_env_present(self.settings),
                firebase_init_error=self.firebase_init_error,
            )
        )


def _firebase_env_present(settings: Settings) -> bool:
    return bool(
        setting_str(settings, "FIREBASE_CREDENTIALS_JSON")
        or setting_str(settings, "FIREBASE_CREDENTIALS_PATH")
        or setting_str(settings, "GOOGLE_APPLICATION_CREDENTIALS")
        or setting_bool(settings, "FIREBASE_USE_APPLICATION_DEFAULT", default=False)
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
        return {sanitize_text(str(key), 120): _sanitize_payload(value) for key, value in payload.items() if sanitize_text(str(key), 120)}
    return redact_basic_pii(sanitize_text(str(payload), 5_000))


def _clean_key(value: str) -> str:
    cleaned = sanitize_text(str(value or ""), 180)
    if not cleaned:
        raise DatabaseError("Document key cannot be empty", code="db_invalid_key")
    return cleaned
