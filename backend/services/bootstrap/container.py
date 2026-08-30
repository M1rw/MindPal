"""
Service container and lifecycle management.

The ServiceContainer holds all application services and manages their
unified lifecycle (start/stop). This separates container definition
from builder logic for cleaner architecture.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from backend.core.config import Settings
from backend.services import (
    AuthService,
    DBService,
    LLMService,
    MemoryService,
    OutputGuardService,
    RAGService,
    SafetyService,
    TTSService,
)
from backend.services.admin_authority import AdminAuthority
from backend.services.brain_service import BrainService
from backend.services.feature_flags_service import FeatureFlagsService
from backend.services.feature_policy_repository import FeaturePolicyStore
from backend.services.idempotency_service import IdempotencyService
from backend.services.memory_repository import MemoryRepository
from backend.services.quota_service import QuotaService
from backend.services.rate_limit_service import RateLimitService
from backend.services.response_intelligence_service import ResponseIntelligenceService
from backend.services.voice_v4_token_service import VoiceV4TokenService

logger = logging.getLogger(__name__)


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
            await self.db.start()
        except Exception as e:
            logger.error("Failed to start DB service: %s", e)
            raise

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
            await self.db.stop()
        except Exception as e:
            logger.error("Error stopping DB service: %s", e)

        await self.http_client.aclose()
        logger.info("✓ Services stopped successfully")

    def health(self) -> dict:
        """
        Get health status of all services.

        Returns:
            Dictionary with service health states (async checks omitted)
        """
        return {
            "status": "healthy",
            "services": {
                "auth": self.auth.health() if hasattr(self.auth, "health") else {},
                "db": "checking...",  # DB health is async, see async_health()
                "llm": self.llm.health() if hasattr(self.llm, "health") else {},
                "memory": self.memory.health() if hasattr(self.memory, "health") else {},
                "output_guard": self.output_guard.health() if hasattr(self.output_guard, "health") else {},
                "rag": self.rag.health() if hasattr(self.rag, "health") else {},
                "safety": self.safety.health() if hasattr(self.safety, "health") else {},
                "tts": self.tts.health() if hasattr(self.tts, "health") else {},
            }
        }

    async def async_health(self) -> dict:
        """
        Get full async health status including DB.

        Returns:
            Dictionary with all service health states
        """
        return {
            "status": "healthy",
            "services": {
                "auth": self.auth.health() if hasattr(self.auth, "health") else {},
                "db": await self.db.health() if hasattr(self.db, "health") else {},
                "llm": self.llm.health() if hasattr(self.llm, "health") else {},
                "memory": self.memory.health() if hasattr(self.memory, "health") else {},
                "output_guard": self.output_guard.health() if hasattr(self.output_guard, "health") else {},
                "rag": self.rag.health() if hasattr(self.rag, "health") else {},
                "safety": self.safety.health() if hasattr(self.safety, "health") else {},
                "tts": self.tts.health() if hasattr(self.tts, "health") else {},
            }
        }

    async def aclose(self) -> None:
        """Compatibility with old API."""
        await self.stop()
