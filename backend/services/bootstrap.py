# Service bootstrap and initialization

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from backend.core.config import Settings, get_settings
from backend.services.core.container import ServiceContainer

# Import all domain services
from backend.services.domain.auth import AuthService, FirebaseAuthProvider, OfflineAuthProvider

logger = logging.getLogger(__name__)


async def bootstrap_services(
    *,
    settings: Settings | None = None,
    container: ServiceContainer | None = None,
    offline_mode: bool = False,
) -> ServiceContainer:
    """
    Initialize all domain services and register with container.
    
    Args:
        settings: Application settings
        container: Optional existing container (creates new if None)
        offline_mode: If True, use offline providers (development)
        
    Returns:
        Initialized ServiceContainer with all services registered
    """
    settings = settings or get_settings()
    container = container or ServiceContainer()
    
    logger.info("Bootstrapping services (offline=%s)", offline_mode)
    
    # ============ AUTH SERVICE ============
    
    if offline_mode:
        auth_provider = OfflineAuthProvider()
        logger.info("Using OfflineAuthProvider (development mode)")
    else:
        auth_provider = FirebaseAuthProvider(settings=settings)
        if not auth_provider.is_configured:
            logger.warning(
                "Firebase not configured. Using OfflineAuthProvider as fallback"
            )
            auth_provider = OfflineAuthProvider()
    
    auth_service = AuthService(
        provider=auth_provider,
        settings=settings,
        allow_anonymous=getattr(settings, "ALLOW_ANONYMOUS_SESSIONS", False),
    )
    
    container.register_singleton("auth_service", auth_service)
    logger.info("✓ Registered AuthService")
    
    # ============ FUTURE SERVICES ============
    # Storage, LLM, Safety, Memory, Voice, RAG, Features, Quota
    # (to be implemented in subsequent phases)
    
    logger.info("✓ All services bootstrapped successfully")
    
    return container


async def create_app_container(settings: Settings | None = None) -> ServiceContainer:
    """
    Create fully-initialized application service container.
    
    This is the main entry point for application startup.
    """
    settings = settings or get_settings()
    offline_mode = getattr(settings, "OFFLINE_MODE", False)
    
    return await bootstrap_services(
        settings=settings,
        offline_mode=offline_mode,
    )

