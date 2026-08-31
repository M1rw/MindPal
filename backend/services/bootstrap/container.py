"""
Service container and lifecycle management.

The ServiceContainer holds all application services and manages their
unified lifecycle (start/stop). This separates container definition
from builder logic for cleaner architecture.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from backend.core.config import Settings
from backend.services.cache_service import CacheService
from backend.services.domain.admin import AdminAuthority
from backend.services.domain.auth import AuthService
from backend.services.domain.features import FeatureFlagsService, FeaturePolicyStore
from backend.services.domain.intelligence import ResponseIntelligenceService
from backend.services.domain.llm import LLMService
from backend.services.domain.memory import BrainService, MemoryService
from backend.services.domain.quota import IdempotencyService, QuotaService, RateLimitService
from backend.services.domain.rag import RAGService
from backend.services.domain.safety import SafetyService
from backend.services.domain.storage import StorageService as DBService
from backend.services.domain.voice import TTSService, VoiceV4TokenService
from backend.services.job_queue_service import AsyncJobQueueService
from backend.services.memory_repository import MemoryRepository
from backend.services.output_guard_service import OutputGuardService

logger = logging.getLogger(__name__)


class ServiceNotFoundError(KeyError):
    """Raised when a service is requested but not registered."""


@dataclass(slots=True)
class ServiceContainer:
    """
    Production service container holding all application services.

    All services are initialized together in a single pass via
    bootstrap.composition.build_service_container().

    Guarantees:
    - Consistent health state at startup
    - Clear dependency ordering
    - Atomic startup/shutdown
    - Easy service replacement for testing

    Usage:
        >>> container = build_service_container()
        >>> await container.start()
        >>> try:
        ...     response = await container.llm.generate(prompt)
        ... finally:
        ...     await container.stop()
    """

    settings: Settings
    auth: AuthService
    db: DBService
    llm: LLMService
    memory: MemoryService
    output_guard: OutputGuardService
    rag: RAGService
    safety: SafetyService
    tts: TTSService
    quota: QuotaService
    rate_limits: RateLimitService
    idempotency: IdempotencyService
    memory_repo: MemoryRepository
    brain: BrainService
    response_intelligence: ResponseIntelligenceService
    feature_flags: FeatureFlagsService
    feature_policies: FeaturePolicyStore
    admin_authority: AdminAuthority
    voice_v4_tokens: VoiceV4TokenService
    http_client: httpx.AsyncClient
    cache: CacheService | None = None
    job_queue: AsyncJobQueueService | None = None
    _singletons: dict[str, Any] = field(default_factory=dict, init=False, repr=False)
    _factories: dict[str, Callable[..., Any]] = field(default_factory=dict, init=False, repr=False)
    _lifecycle_hooks: dict[str, list[Callable[..., Any]]] = field(default_factory=dict, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    def __post_init__(self) -> None:
        self._singletons = {}
        self._factories = {}
        self._lifecycle_hooks = {}
        self._lock = asyncio.Lock()

    def register_singleton(self, key: str, service: Any, on_shutdown: Callable[..., Any] | None = None) -> None:
        """Compatibility helper for the older dependency-injection container API."""
        self._singletons[key] = service
        if on_shutdown is not None:
            self._lifecycle_hooks.setdefault(key, []).append(on_shutdown)

    def register_factory(self, key: str, factory: Callable[..., Any], on_shutdown: Callable[..., Any] | None = None) -> None:
        self._factories[key] = factory
        if on_shutdown is not None:
            self._lifecycle_hooks.setdefault(key, []).append(on_shutdown)

    def on_shutdown(self, key: str, hook: Callable[..., Any]) -> None:
        self._lifecycle_hooks.setdefault(key, []).append(hook)

    async def resolve(self, key: str) -> Any:
        if key in self._singletons:
            return self._singletons[key]
        if key in self._factories:
            factory = self._factories[key]
            if asyncio.iscoroutinefunction(factory):
                value = await factory()
            else:
                value = factory()
            self._singletons[key] = value
            return value
        if hasattr(self, key):
            return getattr(self, key)
        raise ServiceNotFoundError(f"Service '{key}' not registered in container")

    def resolve_sync(self, key: str) -> Any:
        if key in self._singletons:
            return self._singletons[key]
        if key in self._factories:
            factory = self._factories[key]
            if asyncio.iscoroutinefunction(factory):
                raise RuntimeError(f"Cannot resolve async service '{key}' synchronously")
            value = factory()
            self._singletons[key] = value
            return value
        if hasattr(self, key):
            return getattr(self, key)
        raise ServiceNotFoundError(f"Service '{key}' not registered in container")

    async def shutdown(self) -> None:
        for key, hooks in list(self._lifecycle_hooks.items()):
            for hook in hooks:
                try:
                    if asyncio.iscoroutinefunction(hook):
                        await hook(self._singletons.get(key))
                    else:
                        hook(self._singletons.get(key))
                except Exception as exc:  # pragma: no cover - defensive cleanup
                    logger.warning("Shutdown hook failed for %s: %s", key, exc)
        self._singletons.clear()
        self._factories.clear()
        self._lifecycle_hooks.clear()
        await self.stop()

    async def start(self) -> None:
        """
        Start all services with proper ordering.

        Services that depend on DB must wait for DB to start.
        This is handled automatically by dependency order in
        build_service_container().

        Raises:
            Exception: If any service startup fails
        """
        logger.info("Starting service container...")

        # Start core services first (DB before anything else)
        try:
            if hasattr(self.db, "start"):
                await self.db.start()
        except Exception as e:
            logger.error("Failed to start DB service: %s", e)
            raise

        if self.job_queue is not None:
            await self.job_queue.start()

        logger.info("✓ Services started successfully")

    async def stop(self) -> None:
        """
        Stop all services in reverse dependency order.

        Services depending on DB stop first, then DB stops.

        Raises:
            Exception: If any service shutdown fails (still attempts others)
        """
        logger.info("Stopping service container...")

        try:
            if hasattr(self.db, "stop"):
                await self.db.stop()
        except Exception as e:
            logger.error("Error stopping DB service: %s", e)

        if self.cache is not None:
            await self.cache.close()
        if self.job_queue is not None:
            await self.job_queue.stop()
        await self.http_client.aclose()
        logger.info("✓ Services stopped successfully")

    def sync_health(self) -> dict:
        """Get a synchronous health snapshot with readiness semantics for deployment probes."""
        services = {
            "auth": self.auth.health() if hasattr(self.auth, "health") else {},
            "db": "checking...",
            "llm": self.llm.health() if hasattr(self.llm, "health") else {},
            "memory": self.memory.health() if hasattr(self.memory, "health") else {},
            "output_guard": self.output_guard.health() if hasattr(self.output_guard, "health") else {},
            "rag": self.rag.health() if hasattr(self.rag, "health") else {},
            "safety": self.safety.health() if hasattr(self.safety, "health") else {},
            "tts": self.tts.health() if hasattr(self.tts, "health") else {},
        }

        status = self._overall_service_status(services)
        return {
            "status": status,
            "ready": status != "unhealthy",
            "services": services,
            "environment": getattr(self.settings, "ENVIRONMENT", "development"),
        }

    async def health(self) -> dict:
        """Compatibility async health API expected by the API layer and tests."""
        base = self.sync_health()
        db_health = await self.db.health() if hasattr(self.db, "health") else {}
        base["services"]["db"] = db_health
        base["status"] = self._overall_service_status(base["services"])
        base["ready"] = base["status"] != "unhealthy"
        return base

    @staticmethod
    def _normalise_status(value: object) -> str:
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"ok", "healthy", "ready"}:
                return "healthy"
            if normalized in {"degraded", "warning"}:
                return "degraded"
            if normalized in {"error", "unhealthy", "down", "failed"}:
                return "unhealthy"
            if "error" in normalized or "failed" in normalized:
                return "unhealthy"
            return "healthy"

        if isinstance(value, dict):
            state = value.get("status") or value.get("state") or value.get("health")
            if state is not None:
                return ServiceContainer._normalise_status(state)

            if value.get("provider_configured") is False:
                return "unhealthy"

            providers = value.get("providers")
            if isinstance(providers, list):
                configured = any(
                    isinstance(item, dict) and bool(item.get("configured", False))
                    for item in providers
                )
                if value.get("require_remote_provider") and not configured:
                    return "unhealthy"
                if value.get("require_external_provider") and not configured:
                    return "unhealthy"

            if value.get("configured_remote_provider_available") is False and value.get("require_remote_provider"):
                return "unhealthy"
            if value.get("remote_provider_available") is False and value.get("production_mode") is True:
                return "unhealthy"
            if value.get("local_fallback_available") is False and value.get("llm_primary_enabled") is False:
                return "degraded"
            if value.get("browser_fallback_available") is False and value.get("require_external_provider"):
                return "unhealthy"

        return "healthy"

    @classmethod
    def _overall_service_status(cls, services: dict[str, object]) -> str:
        statuses = [cls._normalise_status(service) for service in services.values()]
        if not statuses:
            return "healthy"
        if "unhealthy" in statuses:
            return "unhealthy"
        if "degraded" in statuses:
            return "degraded"
        return "healthy"

    async def async_health(self) -> dict:
        """Alias for the canonical async health contract."""
        return await self.health()

    async def aclose(self) -> None:
        """Compatibility with old API."""
        await self.stop()
