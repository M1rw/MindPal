"""
Service builders - modular factory functions for each service type.

Each builder is responsible for constructing a single service or
closely related group of services. This keeps builders focused,
testable, and easy to maintain.

Builders are organized by category:
- shared_builder: HTTP client and other cross-cutting concerns
- core_builder: Auth, DB, LLM, TTS (foundational services)
- dependent_builder: Services that depend on LLM
- infrastructure_builder: Quota, rate limiting, idempotency
- specialized_builder: Miscellaneous services
- policy_builder: Feature policies and admin authority
"""

from .core_builder import (
    build_auth_service,
    build_db_service,
    build_llm_service,
    build_tts_service,
)
from .dependent_builder import (
    build_memory_service,
    build_output_guard_service,
    build_rag_service,
    build_response_intelligence_service,
    build_safety_service,
)
from .infrastructure_builder import (
    build_cache_service,
    build_idempotency_service,
    build_job_queue_service,
    build_quota_service,
    build_rate_limits_service,
)
from .policy_builder import build_admin_authority, build_feature_policy_store
from .shared_builder import build_http_client
from .specialized_builder import (
    build_brain_service,
    build_feature_flags_service,
    build_memory_repository,
    build_voice_v4_tokens_service,
)

__all__ = [
    # Shared
    "build_http_client",
    # Core
    "build_auth_service",
    "build_db_service",
    "build_llm_service",
    "build_tts_service",
    # Dependent
    "build_memory_service",
    "build_output_guard_service",
    "build_rag_service",
    "build_response_intelligence_service",
    "build_safety_service",
    # Infrastructure
    "build_cache_service",
    "build_idempotency_service",
    "build_job_queue_service",
    "build_quota_service",
    "build_rate_limits_service",
    # Specialized
    "build_brain_service",
    "build_feature_flags_service",
    "build_memory_repository",
    "build_voice_v4_tokens_service",
    # Policy
    "build_admin_authority",
    "build_feature_policy_store",
]
