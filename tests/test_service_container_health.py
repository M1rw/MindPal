from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx

from backend.services.bootstrap.container import ServiceContainer
from backend.services.core.health import HealthChecker, HealthSLO, HealthStatus


class _SyncHealth:
    def __init__(self, payload):
        self.payload = payload

    def health(self):
        return self.payload


class _AsyncHealth:
    def __init__(self, payload):
        self.payload = payload

    async def health(self):
        return self.payload


def _build_container(*, db_payload=None, llm_payload=None):
    db_payload = db_payload or {"status": "healthy"}
    llm_payload = llm_payload or {"providers": [{"configured": True}]}

    return ServiceContainer(
        settings=SimpleNamespace(ENVIRONMENT="production"),
        auth=_SyncHealth({"provider_configured": True}),
        db=_AsyncHealth(db_payload),
        llm=_SyncHealth(llm_payload),
        memory=_SyncHealth({"llm_primary_enabled": True, "local_fallback_available": True}),
        output_guard=_SyncHealth({"rules_loaded": 4}),
        rag=_SyncHealth({"units_loaded": 5}),
        safety=_SyncHealth({"rules_loaded": 6, "templates_loaded": 6, "imminent_self_harm_bypasses_llm": True}),
        tts=_SyncHealth({"providers": [{"configured": True}], "browser_fallback_available": True}),
        quota=SimpleNamespace(),
        rate_limits=SimpleNamespace(),
        idempotency=SimpleNamespace(),
        memory_repo=SimpleNamespace(),
        brain=SimpleNamespace(),
        response_intelligence=SimpleNamespace(),
        feature_flags=SimpleNamespace(),
        feature_policies=SimpleNamespace(),
        admin_authority=SimpleNamespace(),
        voice_v4_tokens=SimpleNamespace(),
        http_client=httpx.AsyncClient(),
    )


def test_sync_health_marks_unhealthy_when_a_core_dependency_is_unhealthy():
    container = _build_container(llm_payload={"providers": [], "require_remote_provider": True})
    try:
        report = container.sync_health()

        assert report["status"] == "unhealthy"
        assert report["ready"] is False
        assert report["services"]["llm"]["providers"] == []
    finally:
        asyncio.run(container.http_client.aclose())


def test_async_health_marks_ready_false_when_database_health_is_unhealthy():
    container = _build_container(db_payload={"status": "error"})
    try:
        report = asyncio.run(container.health())

        assert report["status"] == "unhealthy"
        assert report["ready"] is False
        assert report["services"]["db"]["status"] == "error"
    finally:
        asyncio.run(container.http_client.aclose())


def test_health_checker_uses_slo_thresholds_for_readiness():
    checker = HealthChecker(timeout_seconds=1, slo=HealthSLO(degraded_latency_ms=10, unhealthy_latency_ms=100))

    async def slow_service():
        await asyncio.sleep(0.05)
        return {"status": "healthy", "metadata": {"latency": "slow"}}

    checker.register("slow-service", slow_service)

    result = asyncio.run(checker.check("slow-service"))

    assert result.status == HealthStatus.DEGRADED
    assert result.is_ready is False
