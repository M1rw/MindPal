"""
Service composition and orchestration.

This module contains the main build_service_container function which
orchestrates the building of all services in proper dependency order.

The composition logic is separate from individual builders to make it
easy to understand the complete startup flow and dependency ordering.
"""

import logging

from backend.core.config import Settings, get_settings

from .builders import (
    build_admin_authority,
    build_auth_service,
    build_brain_service,
    build_db_service,
    build_feature_flags_service,
    build_feature_policy_store,
    build_http_client,
    build_idempotency_service,
    build_llm_service,
    build_memory_repository,
    build_memory_service,
    build_output_guard_service,
    build_quota_service,
    build_rag_service,
    build_rate_limits_service,
    build_response_intelligence_service,
    build_safety_service,
    build_tts_service,
    build_voice_v4_tokens_service,
)
from .container import ServiceContainer

logger = logging.getLogger(__name__)


def build_service_container(settings: Settings | None = None) -> ServiceContainer:
    """
    Build the service container for an application instance.

    This is the canonical entry point for service initialization.
    All services are built in dependency order in a single pass.

    Dependency order:
    1. Settings (from environment or passed)
    2. Shared dependencies (HTTP client)
    3. Core services (Auth, DB, LLM, TTS) - must complete before step 4
    4. Dependent services (Memory, Safety, RAG, OutputGuard)
    5. Infrastructure services (Quota, Rate Limits, Idempotency)
    6. Specialized services (Brain, Feature Flags, etc.)
    7. Authorization & Policy services

    Args:
        settings: Application settings (defaults to environment)

    Returns:
        Fully initialized ServiceContainer ready for use

    Raises:
        ConfigError: If required configuration is missing

    Example:
        >>> container = build_service_container()
        >>> await container.start()
        >>> try:
        ...     response = await container.llm.generate(prompt)
        ... finally:
        ...     await container.stop()
    """
    settings = settings or get_settings()

    logger.info(
        "Building service container (env=%s, production=%s)",
        settings.ENVIRONMENT,
        settings.is_production,
    )

    # Step 1: Build shared dependencies
    http_client = build_http_client(settings)

    # Step 2: Build core services (these are dependencies for later services)
    auth = build_auth_service(settings)
    db = build_db_service(settings)
    llm = build_llm_service(settings, http_client)
    tts = build_tts_service(settings, http_client)

    # Step 3: Build services that depend on core services
    memory = build_memory_service(settings, llm)
    output_guard = build_output_guard_service(llm, settings)
    rag = build_rag_service(llm, settings)
    safety = build_safety_service(llm, settings)

    # Step 4: Build infrastructure services
    quota = build_quota_service(db, settings)
    rate_limits = build_rate_limits_service(db)
    idempotency = build_idempotency_service(db, settings)

    # Step 5: Build specialized services
    memory_repo = build_memory_repository(db)
    brain = build_brain_service()
    response_intelligence = build_response_intelligence_service(settings, llm)
    feature_flags = build_feature_flags_service()
    voice_v4_tokens = build_voice_v4_tokens_service(settings, http_client)

    # Step 6: Build authorization and policy services
    feature_policies = build_feature_policy_store(settings, db, http_client)
    admin_authority = build_admin_authority(settings, http_client)

    # Step 7: Assemble all services into container
    container = ServiceContainer(
        settings=settings,
        auth=auth,
        db=db,
        llm=llm,
        memory=memory,
        output_guard=output_guard,
        rag=rag,
        safety=safety,
        tts=tts,
        quota=quota,
        rate_limits=rate_limits,
        idempotency=idempotency,
        memory_repo=memory_repo,
        brain=brain,
        response_intelligence=response_intelligence,
        feature_flags=feature_flags,
        feature_policies=feature_policies,
        admin_authority=admin_authority,
        voice_v4_tokens=voice_v4_tokens,
        http_client=http_client,
    )

    logger.info("✓ Service container built successfully")
    return container
