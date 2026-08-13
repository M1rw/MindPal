"""Controlled in-process load test for MindPal's FastAPI backend.

This script uses the real ASGI application, in-memory persistence, and a delayed
safe provider surrogate. It never targets Vercel, Firebase, or external models.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from backend.api.dependencies import build_service_container  # noqa: E402
from backend.core.config import Settings  # noqa: E402
from backend.main import create_app  # noqa: E402
from backend.models.chat import LLMResponse  # noqa: E402

REPORT_PATH = ROOT / "artifacts" / "backend_api_load_test.json"


@dataclass(frozen=True, slots=True)
class ScenarioResult:
    name: str
    requests: int
    concurrency: int
    elapsed_ms: float
    throughput_rps: float
    status_counts: dict[str, int]
    latency_by_status: dict[str, dict[str, float]]
    p50_ms: float
    p95_ms: float
    max_ms: float


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return round(ordered[index], 2)


async def run_requests(
    client: httpx.AsyncClient,
    *,
    name: str,
    count: int,
    concurrency: int,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    body_factory: Any = None,
) -> ScenarioResult:
    gate = asyncio.Semaphore(concurrency)
    latencies: list[float] = []
    statuses: list[int] = []

    async def issue(index: int) -> None:
        async with gate:
            started = time.perf_counter()
            body = body_factory(index) if body_factory else None
            response = await client.request(method, path, headers=headers, json=body)
            latencies.append((time.perf_counter() - started) * 1_000)
            statuses.append(response.status_code)
            if path == "/api/health":
                assert response.status_code == 200
                assert response.headers.get("cache-control") == "no-store"
                assert response.headers.get("x-request-id") == response.json().get("request_id")

    started = time.perf_counter()
    await asyncio.gather(*(issue(index) for index in range(count)))
    elapsed_ms = (time.perf_counter() - started) * 1_000
    status_counts: dict[str, int] = {}
    latency_by_status_values: dict[str, list[float]] = {}
    for status, latency in zip(statuses, latencies, strict=True):
        key = str(status)
        status_counts[key] = status_counts.get(key, 0) + 1
        latency_by_status_values.setdefault(key, []).append(latency)
    latency_by_status = {
        status: {
            "p50_ms": percentile(values, 0.50),
            "p95_ms": percentile(values, 0.95),
            "max_ms": round(max(values), 2),
        }
        for status, values in latency_by_status_values.items()
    }
    return ScenarioResult(
        name=name,
        requests=count,
        concurrency=concurrency,
        elapsed_ms=round(elapsed_ms, 2),
        throughput_rps=round(count / max(elapsed_ms / 1_000, 0.001), 2),
        status_counts=status_counts,
        latency_by_status=latency_by_status,
        p50_ms=percentile(latencies, 0.50),
        p95_ms=percentile(latencies, 0.95),
        max_ms=round(max(latencies, default=0.0), 2),
    )


def make_settings(*, chat_rate_limit: int, max_concurrent: int) -> Settings:
    return Settings(
        ENVIRONMENT="test",
        ENABLE_FIREBASE=False,
        ALLOW_ANONYMOUS_SESSIONS=True,
        REQUIRE_AUTH_FOR_PROVIDER_CALLS=False,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ENABLE_OFFLINE_LLM_FALLBACK=True,
        ENABLE_LLM_SAFETY_CLASSIFIER=False,
        ENABLE_LLM_OUTPUT_REWRITE=False,
        ENABLE_LLM_RAG_PLANNING=False,
        ENABLE_LLM_MEMORY_SUMMARIZATION=False,
        CHAT_RATE_LIMIT_PER_MINUTE=chat_rate_limit,
        MAX_CONCURRENT_CHAT_REQUESTS_PER_USER=max_concurrent,
        QUOTA_LIMIT_5H=10_000,
        QUOTA_LIMIT_WEEK=10_000,
    )


async def run_campaign() -> dict[str, Any]:
    health_settings = make_settings(chat_rate_limit=10_000, max_concurrent=3)
    app = create_app(health_settings)
    health_transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=health_transport, base_url="http://load-test") as client:
            health = await run_requests(
                client,
                name="health_burst",
                count=1_000,
                concurrency=100,
                method="GET",
                path="/api/health",
            )
            unauthenticated_memory_baseline = await run_requests(
                client,
                name="authenticated_memory_rejection_baseline",
                count=20,
                concurrency=1,
                method="GET",
                path="/api/memory/v3",
            )
            unauthenticated_memory = await run_requests(
                client,
                name="authenticated_memory_rejection_burst",
                count=200,
                concurrency=50,
                method="GET",
                path="/api/memory/v3",
            )

    chat_settings = make_settings(chat_rate_limit=10_000, max_concurrent=3)
    chat_app = create_app(chat_settings)
    services = build_service_container(chat_settings)

    async def delayed_safe_generation(_: object) -> SimpleNamespace:
        await asyncio.sleep(1.2)
        return SimpleNamespace(
            response=LLMResponse(
                text="This is a controlled safe load-test reply.",
                provider_used="load-test-fake",
                fallback_count=0,
                latency_ms=1_200.0,
            )
        )

    services.llm.generate_with_trace = delayed_safe_generation  # type: ignore[method-assign]
    chat_app.state.service_container = services
    chat_transport = httpx.ASGITransport(app=chat_app)
    chat_headers = {"X-Anonymous-User": "controlled-load-user", "X-MindPal-Channel": "test"}

    def chat_body(index: int) -> dict[str, Any]:
        return {
            "message": f"Controlled load request {index}",
            "history": [],
            "metadata": {
                "locale": "en",
                "channel": "test",
                "client_request_id": f"load-concurrency-{index}",
            },
            "stream": True,
        }

    async with chat_app.router.lifespan_context(chat_app):
        async with httpx.AsyncClient(transport=chat_transport, base_url="http://load-test") as client:
            chat_concurrency = await run_requests(
                client,
                name="chat_concurrency_limit",
                count=12,
                concurrency=12,
                method="POST",
                path="/api/chat/stream",
                headers=chat_headers,
                body_factory=chat_body,
            )

    rate_settings = make_settings(chat_rate_limit=5, max_concurrent=20)
    rate_app = create_app(rate_settings)
    rate_services = build_service_container(rate_settings)

    async def immediate_safe_generation(_: object) -> SimpleNamespace:
        return SimpleNamespace(
            response=LLMResponse(
                text="This is a controlled safe load-test reply.",
                provider_used="load-test-fake",
                fallback_count=0,
                latency_ms=0.1,
            )
        )

    rate_services.llm.generate_with_trace = immediate_safe_generation  # type: ignore[method-assign]
    rate_app.state.service_container = rate_services
    rate_transport = httpx.ASGITransport(app=rate_app)
    async with rate_app.router.lifespan_context(rate_app):
        async with httpx.AsyncClient(transport=rate_transport, base_url="http://load-test") as client:
            chat_rate = await run_requests(
                client,
                name="chat_rate_limit_burst",
                count=20,
                concurrency=20,
                method="POST",
                path="/api/chat/stream",
                headers=chat_headers,
                body_factory=lambda index: {
                    **chat_body(index),
                    "metadata": {
                        "locale": "en",
                        "channel": "test",
                        "client_request_id": f"load-rate-{index}",
                    },
                },
            )

    return {
        "scope": "local in-process ASGI only; no external providers or deployed services",
        "scenarios": [asdict(item) for item in (health, unauthenticated_memory_baseline, unauthenticated_memory, chat_concurrency, chat_rate)],
    }


async def main() -> int:
    report = await run_campaign()
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
