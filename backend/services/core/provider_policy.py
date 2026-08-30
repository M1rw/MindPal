# backend/services/core/provider_policy.py
"""
Provider policy enforcement for production reliability.

Centralizes all provider configuration decisions:
- Which providers to use and in what order
- Retry budgets and backoff strategies
- Quota ceilings and cost caps
- Model selection policies per request class
- Timeout budgets per operation type

This replaces ad-hoc constructor logic and makes policies testable and tuneable.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional

logger = logging.getLogger(__name__)


class RequestClass(Enum):
    """Request classification for policy application."""
    CRITICAL = "critical"           # Safety, auth, crisis response
    HIGH_PRIORITY = "high_priority" # Chat, memory, user-facing
    STANDARD = "standard"           # Background, async operations
    LOW_PRIORITY = "low_priority"   # Analytics, monitoring
    BATCH = "batch"                 # Bulk processing


class ProviderTier(Enum):
    """Provider capability tier."""
    PREMIUM = "premium"             # Fastest, most capable, highest cost
    STANDARD = "standard"           # Good balance of cost/capability
    BUDGET = "budget"               # Lowest cost, acceptable quality
    FALLBACK = "fallback"           # Emergency only (offline, mock)


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Retry strategy for provider failures."""
    max_attempts: int = 3
    initial_backoff_ms: float = 100.0
    max_backoff_ms: float = 5_000.0
    backoff_multiplier: float = 2.0
    jitter_factor: float = 0.1  # ±10% random variation

    def get_backoff_ms(self, attempt: int) -> float:
        """Calculate backoff duration for nth attempt (0-indexed)."""
        if attempt <= 0:
            return 0.0
        
        # Exponential backoff: 100ms → 200ms → 400ms → ...
        backoff = self.initial_backoff_ms * (self.backoff_multiplier ** attempt)
        backoff = min(backoff, self.max_backoff_ms)
        
        # Add jitter to avoid thundering herd
        import random
        variance = backoff * self.jitter_factor
        return backoff + random.uniform(-variance, variance)


@dataclass(frozen=True, slots=True)
class CircuitBreakerPolicy:
    """Circuit breaker thresholds for provider."""
    failure_threshold: int = 5      # Failures before opening
    recovery_timeout_seconds: float = 60.0
    half_open_requests: int = 3     # Requests to try during recovery

    @property
    def max_failures(self) -> int:
        """Alias for failure_threshold."""
        return self.failure_threshold


@dataclass(frozen=True, slots=True)
class ProviderConfig:
    """
    Configuration for a single LLM provider.
    
    Defines cost, capability, and reliability characteristics.
    """
    name: str                                   # "openai", "gemini", "openrouter"
    tier: ProviderTier = ProviderTier.STANDARD
    enabled: bool = True
    timeout_seconds: float = 45.0
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    circuit_breaker: CircuitBreakerPolicy = field(default_factory=CircuitBreakerPolicy)
    
    # Cost model (for quota tracking)
    cost_per_1k_prompt_tokens: float = 0.0
    cost_per_1k_completion_tokens: float = 0.0
    monthly_budget_usd: float = 1_000.0
    
    # Capability flags
    supports_vision: bool = False
    supports_function_calling: bool = True
    supports_streaming: bool = True
    supports_batching: bool = False
    
    # Request budgets
    max_daily_requests: int = 1_000_000
    rate_limit_per_minute: int = 3_000
    
    # Model selection
    default_model: str = ""
    vision_model: str | None = None
    coding_model: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderPolicyForRequest:
    """
    Policy applied to a single request based on its class.
    """
    request_class: RequestClass
    providers_in_order: tuple[str, ...]      # ["gemini", "openrouter", "fallback"]
    timeout_seconds: float = 45.0
    max_retries: int = 2
    allow_offline_fallback: bool = True
    cost_budget_cents: int = 50                # Max cost in cents for this request


class ProviderPolicyRegistry:
    """
    Centralized registry of provider configurations and request-level policies.
    
    This is the source of truth for:
    - Which providers are configured
    - Their capabilities and costs
    - Request-level policies (which providers to try, timeout, retries)
    """

    def __init__(self) -> None:
        self._providers: dict[str, ProviderConfig] = {}
        self._request_policies: dict[RequestClass, ProviderPolicyForRequest] = {}
        self._default_policy: ProviderPolicyForRequest | None = None

    def register_provider(self, config: ProviderConfig) -> None:
        """Register a provider with its configuration."""
        logger.info(
            "Registering provider: %s (tier=%s, timeout=%s, enabled=%s)",
            config.name,
            config.tier.value,
            config.timeout_seconds,
            config.enabled,
        )
        self._providers[config.name] = config

    def register_request_policy(self, policy: ProviderPolicyForRequest) -> None:
        """Register request-class-specific policy."""
        logger.info(
            "Registering policy for %s: providers=%s, timeout=%s, budget=%s¢",
            policy.request_class.value,
            ",".join(policy.providers_in_order),
            policy.timeout_seconds,
            policy.cost_budget_cents,
        )
        self._request_policies[policy.request_class] = policy

    def set_default_policy(self, policy: ProviderPolicyForRequest) -> None:
        """Set default policy for unspecified request classes."""
        self._default_policy = policy

    def get_provider(self, name: str) -> ProviderConfig | None:
        """Get provider config by name."""
        return self._providers.get(name)

    def get_all_providers(self) -> dict[str, ProviderConfig]:
        """Get all registered providers."""
        return dict(self._providers)

    def get_policy_for_request(self, request_class: RequestClass) -> ProviderPolicyForRequest:
        """Get policy for request class."""
        if request_class in self._request_policies:
            return self._request_policies[request_class]
        
        if self._default_policy is not None:
            return self._default_policy
        
        # Fallback: conservative policy
        logger.warning("No policy registered for %s, using fallback", request_class.value)
        return ProviderPolicyForRequest(
            request_class=request_class,
            providers_in_order=tuple(name for name, config in self._providers.items() if config.enabled),
            timeout_seconds=30.0,
            max_retries=1,
            allow_offline_fallback=False,
            cost_budget_cents=20,
        )

    def to_dict(self) -> dict:
        """Export configuration for observability."""
        return {
            "providers": {
                name: {
                    "tier": config.tier.value,
                    "enabled": config.enabled,
                    "timeout_seconds": config.timeout_seconds,
                    "supports_vision": config.supports_vision,
                    "monthly_budget_usd": config.monthly_budget_usd,
                    "rate_limit_per_minute": config.rate_limit_per_minute,
                }
                for name, config in self._providers.items()
            },
            "policies": {
                request_class.value: {
                    "providers": policy.providers_in_order,
                    "timeout_seconds": policy.timeout_seconds,
                    "max_retries": policy.max_retries,
                    "cost_budget_cents": policy.cost_budget_cents,
                }
                for request_class, policy in self._request_policies.items()
            }
        }


# ═══════════════════════════════════════════════════════════════
# Default Production Policies
# ═══════════════════════════════════════════════════════════════

def create_default_production_policy() -> ProviderPolicyRegistry:
    """
    Create default production provider policy registry.
    
    This reflects best practices for a mental wellness app:
    - Safety-critical requests use strong models with tight timeouts
    - User-facing requests balance cost and quality
    - Batch operations are cost-optimized
    - Offline fallback for crisis responses only
    """
    registry = ProviderPolicyRegistry()
    
    # Gemini: Fast, cost-effective, good quality
    registry.register_provider(ProviderConfig(
        name="gemini",
        tier=ProviderTier.STANDARD,
        enabled=True,
        timeout_seconds=30.0,
        retry_policy=RetryPolicy(max_attempts=3),
        circuit_breaker=CircuitBreakerPolicy(failure_threshold=5),
        cost_per_1k_prompt_tokens=0.075,
        cost_per_1k_completion_tokens=0.30,
        monthly_budget_usd=500.0,
        supports_vision=True,
        supports_function_calling=True,
        supports_streaming=True,
        default_model="gemini-2.0-flash-lite",
        vision_model="gemini-2.0-flash-lite",
        rate_limit_per_minute=1_000,
    ))
    
    # OpenRouter: Model diversity, fallback layer
    registry.register_provider(ProviderConfig(
        name="openrouter",
        tier=ProviderTier.STANDARD,
        enabled=True,
        timeout_seconds=45.0,
        retry_policy=RetryPolicy(max_attempts=2),
        circuit_breaker=CircuitBreakerPolicy(failure_threshold=5, recovery_timeout_seconds=120.0),
        cost_per_1k_prompt_tokens=0.15,
        cost_per_1k_completion_tokens=0.60,
        monthly_budget_usd=300.0,
        supports_vision=False,
        supports_function_calling=True,
        supports_streaming=True,
        default_model="openai/gpt-4o-mini",
        rate_limit_per_minute=500,
    ))
    
    # Offline: Emergency fallback (no API cost)
    registry.register_provider(ProviderConfig(
        name="offline",
        tier=ProviderTier.FALLBACK,
        enabled=True,
        timeout_seconds=1.0,
        retry_policy=RetryPolicy(max_attempts=1),
        circuit_breaker=CircuitBreakerPolicy(failure_threshold=1_000),
        cost_per_1k_prompt_tokens=0.0,
        cost_per_1k_completion_tokens=0.0,
        monthly_budget_usd=0.0,
        supports_vision=False,
        supports_function_calling=False,
        supports_streaming=True,
        default_model="offline-deterministic",
        rate_limit_per_minute=10_000,  # Unlimited
    ))
    
    # Policy: Safety-critical requests (crisis response)
    registry.register_request_policy(ProviderPolicyForRequest(
        request_class=RequestClass.CRITICAL,
        providers_in_order=("gemini", "openrouter"),  # Strong models, no offline
        timeout_seconds=15.0,
        max_retries=2,
        allow_offline_fallback=False,
        cost_budget_cents=50,
    ))
    
    # Policy: User-facing requests (chat, memory)
    registry.register_request_policy(ProviderPolicyForRequest(
        request_class=RequestClass.HIGH_PRIORITY,
        providers_in_order=("gemini", "openrouter"),
        timeout_seconds=30.0,
        max_retries=2,
        allow_offline_fallback=True,
        cost_budget_cents=30,
    ))
    
    # Policy: Standard operations
    registry.register_request_policy(ProviderPolicyForRequest(
        request_class=RequestClass.STANDARD,
        providers_in_order=("gemini", "openrouter"),
        timeout_seconds=45.0,
        max_retries=1,
        allow_offline_fallback=True,
        cost_budget_cents=20,
    ))
    
    # Policy: Background/batch (cost-optimized)
    registry.register_request_policy(ProviderPolicyForRequest(
        request_class=RequestClass.BATCH,
        providers_in_order=("gemini",),  # Cheapest option
        timeout_seconds=120.0,
        max_retries=0,  # Batch failures are retried at job level
        allow_offline_fallback=False,
        cost_budget_cents=10,
    ))
    
    # Set default policy
    registry.set_default_policy(ProviderPolicyForRequest(
        request_class=RequestClass.STANDARD,
        providers_in_order=("gemini", "openrouter"),
        timeout_seconds=45.0,
        max_retries=1,
        allow_offline_fallback=True,
        cost_budget_cents=20,
    ))
    
    logger.info("✓ Default production provider policy registered")
    return registry


def create_development_policy() -> ProviderPolicyRegistry:
    """
    Create development provider policy registry.
    
    Prioritizes:
    - Fast feedback (lower timeouts)
    - Offline fallback enabled
    - Cost-insensitive
    """
    registry = ProviderPolicyRegistry()
    
    # Enable offline provider for development
    registry.register_provider(ProviderConfig(
        name="offline",
        tier=ProviderTier.FALLBACK,
        enabled=True,
        timeout_seconds=1.0,
        default_model="offline-deterministic",
    ))
    
    # Gemini if configured, but optional
    registry.register_provider(ProviderConfig(
        name="gemini",
        tier=ProviderTier.STANDARD,
        enabled=True,
        timeout_seconds=10.0,
        default_model="gemini-2.0-flash-lite",
    ))
    
    # Default: use offline-first in dev
    registry.set_default_policy(ProviderPolicyForRequest(
        request_class=RequestClass.STANDARD,
        providers_in_order=("offline", "gemini"),
        timeout_seconds=10.0,
        max_retries=0,
        allow_offline_fallback=True,
        cost_budget_cents=0,
    ))
    
    logger.info("✓ Development provider policy registered")
    return registry
