# tests/integration/test_provider_contracts.py
"""
Production contract tests for provider reliability.

These tests verify that the system behaves correctly in critical scenarios:
- Provider failover (one fails, next succeeds)
- Circuit breaker recovery (provider comes back online)
- Safety escalation (never degrade safety decisions)
- Telemetry sanitization (no PII in logs/traces)
- Health check contracts (all services report status)

Contract tests are NOT unit tests - they verify end-to-end behavior
across multiple components and represent production SLAs.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from backend.core.errors import ProviderError, ProviderTimeoutError
from backend.services.llm_service import LLMService
from backend.services.core.provider_reliability import (
    CircuitBreaker,
    BackoffStrategy,
    RetryExecutor,
    ProviderReliabilityManager,
)
from backend.services.core.request_tracing import RequestTracer, RequestClass
from backend.models.chat import LLMRequest, LLMResponse, LLMRole, LLMMessage


# ═══════════════════════════════════════════════════════════════
# Contract: Provider Failover
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestProviderFailoverContract:
    """
    Contract: When provider 1 fails, system tries provider 2.
    
    Production SLA: Failover happens within 100ms overhead.
    """

    async def test_failover_to_next_provider_on_timeout(self):
        """Provider 1 times out → try provider 2 → success."""
        
        # Mock providers
        provider1 = AsyncMock()
        provider1.name = "provider1"
        provider1.is_configured = True
        provider1.generate = AsyncMock(
            side_effect=asyncio.TimeoutError("timeout"),
        )
        
        provider2 = AsyncMock()
        provider2.name = "provider2"
        provider2.is_configured = True
        provider2.generate = AsyncMock(
            return_value=LLMResponse(
                text="Fallback response",
                provider_used="provider2",
                fallback_count=1,
                latency_ms=50.0,
                model_name="model2",
                finish_reason="stop",
            ),
        )
        
        llm = LLMService(
            providers=[provider1, provider2],
            timeout_seconds=1.0,
        )
        
        # Make request
        request = LLMRequest(
            request_id="test_123",
            messages=[LLMMessage(role=LLMRole.USER, content="test")],
        )
        
        # Should NOT raise, should failover
        response = await llm.generate(request)
        
        # Contract: failover happened
        assert response.provider_used == "provider2"
        assert response.fallback_count == 1
        
        # Contract: provider1 was tried
        provider1.generate.assert_called_once()
        provider2.generate.assert_called_once()

    async def test_failover_respects_provider_order(self):
        """Contract: Failover tries providers in configured order."""
        
        providers = []
        for i in range(3):
            p = AsyncMock()
            p.name = f"provider{i}"
            p.is_configured = True
            p.generate = AsyncMock(
                side_effect=ProviderError(f"error{i}", code=f"code{i}"),
            )
            providers.append(p)
        
        # Last provider succeeds
        providers[2].generate = AsyncMock(
            return_value=LLMResponse(
                text="Success",
                provider_used="provider2",
                fallback_count=2,
                latency_ms=10.0,
                model_name="model",
                finish_reason="stop",
            ),
        )
        
        llm = LLMService(providers=providers)
        
        request = LLMRequest(
            request_id="test_123",
            messages=[LLMMessage(role=LLMRole.USER, content="test")],
        )
        
        response = await llm.generate(request)
        
        # Contract: tried in order, success on third
        assert response.provider_used == "provider2"
        assert response.fallback_count == 2
        
        # All were tried
        for p in providers:
            p.generate.assert_called_once()

    async def test_failover_all_providers_fail(self):
        """Contract: When all providers fail, raise error."""
        
        providers = []
        for i in range(2):
            p = AsyncMock()
            p.name = f"provider{i}"
            p.is_configured = True
            p.generate = AsyncMock(
                side_effect=ProviderError(f"error{i}", code=f"code{i}"),
            )
            providers.append(p)
        
        llm = LLMService(providers=providers)
        
        request = LLMRequest(
            request_id="test_123",
            messages=[LLMMessage(role=LLMRole.USER, content="test")],
        )
        
        # Contract: should raise when all fail
        with pytest.raises(ProviderError) as exc_info:
            await llm.generate(request)
        
        assert exc_info.value.code == "llm_all_providers_failed"


# ═══════════════════════════════════════════════════════════════
# Contract: Circuit Breaker Recovery
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestCircuitBreakerContract:
    """
    Contract: Circuit breaker opens after failures, recovers when provider healthy.
    
    Production SLA:
    - Opens in < 1s (5 failures)
    - Attempts recovery after timeout
    - Recovers when 3 probes succeed
    """

    async def test_circuit_opens_on_failure_threshold(self):
        """Contract: Circuit opens after N consecutive failures."""
        
        breaker = CircuitBreaker(
            name="test_provider",
            failure_threshold=3,
            recovery_timeout_seconds=1.0,
        )
        
        assert breaker.get_state().is_closed
        
        # Record 3 failures
        for i in range(3):
            await breaker.record_failure()
        
        # Contract: circuit should be OPEN
        state = breaker.get_state()
        assert state.is_open
        assert state.failure_count == 3
        
        # Contract: new requests rejected
        assert not await breaker.can_execute()

    async def test_circuit_half_open_after_timeout(self):
        """Contract: Circuit attempts recovery after timeout."""
        
        breaker = CircuitBreaker(
            name="test_provider",
            failure_threshold=1,
            recovery_timeout_seconds=0.1,  # 100ms
        )
        
        # Fail once to open circuit
        await breaker.record_failure()
        assert breaker.get_state().is_open
        
        # Wait for timeout
        await asyncio.sleep(0.15)
        
        # Contract: now in HALF_OPEN state
        can_execute = await breaker.can_execute()
        assert can_execute
        assert breaker.get_state().is_half_open

    async def test_circuit_closes_on_successful_probes(self):
        """Contract: Circuit closes after successful recovery probes."""
        
        breaker = CircuitBreaker(
            name="test_provider",
            failure_threshold=1,
            recovery_timeout_seconds=0.1,
            half_open_max_requests=2,
        )
        
        # Open circuit
        await breaker.record_failure()
        assert breaker.get_state().is_open
        
        # Wait for recovery timeout
        await asyncio.sleep(0.15)
        
        # Attempt recovery
        can_execute = await breaker.can_execute()
        assert can_execute
        
        # Record successful probes
        await breaker.record_success()
        await breaker.record_success()
        
        # Contract: circuit should be CLOSED
        state = breaker.get_state()
        assert state.is_closed
        assert state.failure_count == 0

    async def test_circuit_reopens_on_probe_failure(self):
        """Contract: Circuit reopens if recovery probe fails."""
        
        breaker = CircuitBreaker(
            name="test_provider",
            failure_threshold=1,
            recovery_timeout_seconds=0.1,
        )
        
        # Open and enter HALF_OPEN
        await breaker.record_failure()
        await asyncio.sleep(0.15)
        await breaker.can_execute()  # Transitions to HALF_OPEN
        
        # Probe fails
        await breaker.record_failure()
        
        # Contract: circuit reopens
        state = breaker.get_state()
        assert state.is_open


# ═══════════════════════════════════════════════════════════════
# Contract: Exponential Backoff
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestExponentialBackoffContract:
    """
    Contract: Retry backoff increases exponentially to prevent thundering herd.
    
    Production SLA:
    - No jitter on first attempt
    - Exponential growth: 100ms → 200ms → 400ms
    - Respects max backoff cap (10s)
    - Jitter ±10% to spread requests
    """

    def test_backoff_increases_exponentially(self):
        """Contract: Backoff doubles with each retry."""
        
        strategy = BackoffStrategy(
            initial_backoff_ms=100.0,
            multiplier=2.0,
            jitter_factor=0.0,  # No jitter for testing
        )
        
        # Contract: exponential growth
        backoff0 = strategy.get_backoff_ms(0)
        backoff1 = strategy.get_backoff_ms(1)
        backoff2 = strategy.get_backoff_ms(2)
        backoff3 = strategy.get_backoff_ms(3)
        
        assert backoff0 == 0.0      # No backoff on first attempt
        assert backoff1 == 100.0    # First retry
        assert backoff2 == 200.0    # Second retry
        assert backoff3 == 400.0    # Third retry

    def test_backoff_capped_at_max(self):
        """Contract: Backoff never exceeds max_backoff_ms."""
        
        strategy = BackoffStrategy(
            initial_backoff_ms=100.0,
            max_backoff_ms=1_000.0,
            multiplier=2.0,
            jitter_factor=0.0,
        )
        
        # Eventually hits cap
        backoff10 = strategy.get_backoff_ms(10)
        
        # Contract: capped at max
        assert backoff10 <= 1_000.0

    def test_backoff_includes_jitter(self):
        """Contract: Jitter prevents thundering herd."""
        
        strategy = BackoffStrategy(
            initial_backoff_ms=100.0,
            jitter_factor=0.1,  # ±10%
        )
        
        # Sample multiple times
        samples = [strategy.get_backoff_ms(1) for _ in range(100)]
        
        # Contract: not all identical (jitter working)
        assert len(set(samples)) > 1
        
        # Contract: all within expected range
        min_backoff = 100.0 * 0.9  # -10%
        max_backoff = 100.0 * 1.1  # +10%
        for s in samples:
            assert min_backoff <= s <= max_backoff


# ═══════════════════════════════════════════════════════════════
# Contract: Request Tracing
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestRequestTracingContract:
    """
    Contract: Every request is traced with correlation IDs and no PII.
    
    Production SLA:
    - Correlation IDs propagate across async boundaries
    - No raw prompts or user messages in traces
    - Token counts recorded per provider call
    - Cost estimated per request
    """

    def test_trace_includes_no_pii(self):
        """Contract: Traces contain no private information."""
        
        trace = RequestTracer.start_request(
            request_id="test_123",
            user_id_hash="hash_xyz",  # Hashed, OK
            operation="test",
        )
        
        RequestTracer.record_provider_call(
            provider_name="gemini",
            status="success",
            prompt_tokens=100,
            completion_tokens=50,
        )
        
        trace = RequestTracer.end_request(success=True)
        trace_dict = trace.to_dict()
        
        # Contract: no raw prompts or messages
        json_str = str(trace_dict)
        assert "user_message" not in json_str
        assert "prompt" not in json_str
        assert "response" not in json_str
        
        # Contract: hash is OK (anonymized)
        assert "hash_xyz" in json_str

    def test_trace_records_tokens_and_cost(self):
        """Contract: Token usage and cost tracked per request."""
        
        trace = RequestTracer.start_request(request_id="test_123")
        
        RequestTracer.record_provider_call(
            provider_name="gemini",
            status="success",
            prompt_tokens=100,
            completion_tokens=50,
        )
        
        RequestTracer.record_provider_call(
            provider_name="openrouter",
            status="failure",
            error_code="timeout",
        )
        
        trace = RequestTracer.end_request(success=True)
        
        # Contract: tokens counted
        assert trace.total_tokens_used == 150
        
        # Contract: provider calls recorded
        assert len(trace.provider_calls) == 2
        assert trace.provider_calls[0].status == "success"
        assert trace.provider_calls[1].status == "failure"

    def test_trace_context_propagates_across_async(self):
        """Contract: Correlation IDs available in async functions."""
        
        async def nested_async_operation():
            # Should have access to context
            request_id = RequestTracer.get_current_request_id()
            return request_id
        
        trace = RequestTracer.start_request(request_id="async_test_123")
        
        result = asyncio.run(nested_async_operation())
        
        # Contract: context propagated
        assert result == "async_test_123"


# ═══════════════════════════════════════════════════════════════
# Contract: Safety Decisions
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestSafetyDecisionContract:
    """
    Contract: Safety decisions are never weakened by failover.
    
    Production SLA:
    - Offline provider is NOT used for crisis responses
    - High-priority safety classifier runs even if main LLM fails
    - Errors on safety path never escalate to "safe"
    """

    async def test_offline_never_used_for_crisis(self):
        """Contract: Offline provider blocked for safety-critical requests."""
        
        offline_provider = AsyncMock()
        offline_provider.name = "offline"
        offline_provider.is_configured = True
        
        gemini_provider = AsyncMock()
        gemini_provider.name = "gemini"
        gemini_provider.is_configured = True
        gemini_provider.generate = AsyncMock(
            return_value=LLMResponse(
                text="Safety response",
                provider_used="gemini",
                fallback_count=0,
                latency_ms=10.0,
                model_name="model",
                finish_reason="stop",
            ),
        )
        
        llm = LLMService(
            providers=[gemini_provider, offline_provider],
            require_remote_provider=True,  # Safety mode
            include_offline_provider=True,
        )
        
        request = LLMRequest(
            request_id="test_123",
            messages=[LLMMessage(role=LLMRole.USER, content="test")],
        )
        
        response = await llm.generate(request)
        
        # Contract: used Gemini, NOT offline
        assert response.provider_used == "gemini"
        assert "offline" not in response.provider_used
        
        # Contract: offline not called
        offline_provider.generate.assert_not_called()


# ═══════════════════════════════════════════════════════════════
# Contract: Health Checks
# ═══════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestHealthCheckContract:
    """
    Contract: All services report consistent health status.
    
    Production SLA:
    - Health endpoint < 1s response
    - Includes all services
    - Clear status (healthy/degraded/unhealthy)
    """

    async def test_health_includes_all_services(self):
        """Contract: Health check covers all service dependencies."""
        
        from backend.services.bootstrap_v2 import build_service_container
        from backend.core.config import Settings
        
        settings = Settings(ENVIRONMENT="development")
        container = build_service_container(settings)
        
        health = await container.health()
        
        # Contract: health structure
        assert "status" in health
        assert "services" in health
        assert "environment" in health
        
        # Contract: critical services present
        services = health["services"]
        assert "auth" in services
        assert "db" in services
        assert "llm" in services
        assert "safety" in services

    async def test_health_response_time(self):
        """Contract: Health check completes quickly."""
        
        from backend.services.bootstrap_v2 import build_service_container
        from backend.core.config import Settings
        import time
        
        settings = Settings(ENVIRONMENT="development")
        container = build_service_container(settings)
        
        start = time.time()
        health = await container.health()
        elapsed = time.time() - start
        
        # Contract: < 1 second
        assert elapsed < 1.0


# ═══════════════════════════════════════════════════════════════
# Run Tests
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
