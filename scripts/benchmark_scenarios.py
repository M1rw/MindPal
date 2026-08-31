"""Realistic performance benchmark for MindPal backend.

Simulates mixed production traffic:
1. Sync Chat with Memory & RAG
2. SSE Chat Streaming
3. Memory V3 Merging & Graph Loading
4. Obsidian Brain Graph Queries
5. Concurrent mixed traffic under sustained load

Measures p50, p95, p99 latency, throughput (req/s), and memory usage (RSS MB).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import resource
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from httpx import ASGITransport, AsyncClient  # noqa: E402

from backend.core.config import Settings  # noqa: E402
from backend.main import create_app  # noqa: E402


logging.getLogger("mindpal").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)


@dataclass(frozen=True, slots=True)
class BenchmarkMetrics:
    scenario_name: str
    total_requests: int
    concurrency: int
    duration_seconds: float
    throughput_rps: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    max_ms: float
    memory_rss_mb: float
    success_rate: float


def calculate_percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(len(s) * pct)))
    return round(s[idx], 2)


def current_rss_mb() -> float:
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 2)


async def run_scenario(
    client: AsyncClient,
    *,
    name: str,
    total_requests: int,
    concurrency: int,
    request_func: Any,
) -> BenchmarkMetrics:
    semaphore = asyncio.Semaphore(concurrency)
    latencies: list[float] = []
    successes = 0

    async def worker(index: int):
        nonlocal successes
        async with semaphore:
            t0 = time.perf_counter()
            try:
                res = await request_func(client, index)
                elapsed_ms = (time.perf_counter() - t0) * 1000
                latencies.append(elapsed_ms)
                if res and res.status_code == 200:
                    successes += 1
            except Exception:
                elapsed_ms = (time.perf_counter() - t0) * 1000
                latencies.append(elapsed_ms)

    t_start = time.perf_counter()
    await asyncio.gather(*[worker(i) for i in range(total_requests)])
    t_duration = time.perf_counter() - t_start
    end_rss = current_rss_mb()

    return BenchmarkMetrics(
        scenario_name=name,
        total_requests=total_requests,
        concurrency=concurrency,
        duration_seconds=round(t_duration, 3),
        throughput_rps=round(total_requests / max(0.001, t_duration), 2),
        p50_ms=calculate_percentile(latencies, 0.50),
        p95_ms=calculate_percentile(latencies, 0.95),
        p99_ms=calculate_percentile(latencies, 0.99),
        max_ms=round(max(latencies, default=0.0), 2),
        memory_rss_mb=end_rss,
        success_rate=round(successes / total_requests, 4),
    )


async def run_all_benchmarks() -> list[BenchmarkMetrics]:
    settings = Settings(
        ENVIRONMENT="test",
        LOG_LEVEL="ERROR",
        ENABLE_METRICS=False,
        REQUIRE_REMOTE_LLM_PROVIDER=False,
        ALLOW_OFFLINE_LLM_IN_PRODUCTION=True,
        ENABLE_OFFLINE_LLM_FALLBACK=True,
        REQUIRE_AUTH_FOR_PROVIDER_CALLS=False,
        ALLOW_ANONYMOUS_SESSIONS=True,
        CHAT_RATE_LIMIT_PER_MINUTE=10_000,
        TOOL_RATE_LIMIT_PER_MINUTE=10_000,
        MEMORY_WRITE_RATE_LIMIT_PER_MINUTE=10_000,
        MAX_CONCURRENT_CHAT_REQUESTS_PER_USER=20,
    )
    app = create_app(settings)
    transport = ASGITransport(app=app)

    results: list[BenchmarkMetrics] = []

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://benchmark") as client:
            # 1. Sync Chat
            async def sync_chat_req(cli, i):
                headers = {
                    "Authorization": "Bearer benchmark_token",
                    "X-MindPal-User-ID": f"bench_user_{i % 10}",
                    "X-MindPal-Locale": "en",
                    "X-MindPal-Channel": "web",
                }
                return await cli.post(
                    "/api/chat",
                    json={
                        "message": f"I am feeling anxious about work performance {i}",
                        "history": [
                            {"role": "user", "content": "Hello MindPal"},
                            {"role": "assistant", "content": "Hello! How can I support you today?"},
                        ],
                        "metadata": {"locale": "en", "model": "standard"},
                    },
                    headers=headers,
                )

            m_sync = await run_scenario(client, name="Scenario 1: Sync Chat", total_requests=100, concurrency=10, request_func=sync_chat_req)
            results.append(m_sync)

            # 2. SSE Chat Streaming
            async def sse_chat_req(cli, i):
                headers = {
                    "Authorization": "Bearer benchmark_token",
                    "X-MindPal-User-ID": f"bench_user_{i % 10}",
                    "X-MindPal-Locale": "en",
                    "X-MindPal-Channel": "web",
                }
                return await cli.post(
                    "/api/chat/stream",
                    json={
                        "message": f"Can you give me a grounding exercise? {i}",
                        "history": [],
                        "metadata": {"locale": "en"},
                    },
                    headers=headers,
                )

            m_sse = await run_scenario(client, name="Scenario 2: SSE Chat Stream", total_requests=100, concurrency=10, request_func=sse_chat_req)
            results.append(m_sse)

            # 3. Memory V3 Merge & Query
            async def memory_req(cli, i):
                headers = {
                    "Authorization": "Bearer benchmark_token",
                    "X-MindPal-User-ID": f"bench_user_{i % 10}",
                    "X-MindPal-Locale": "en",
                }
                if i % 2 == 0:
                    return await cli.get("/api/memory/v3", headers=headers)
                return await cli.post(
                    "/api/memory/v3/merge",
                    json={
                        "atoms": [
                            {
                                "id": f"bench_atom_{i}",
                                "category": "preferences",
                                "key": f"preferences:item_{i}",
                                "value": f"User preference item {i}",
                                "normalized_value": f"user preference item {i}",
                                "display_value": f"Preference {i}",
                            }
                        ]
                    },
                    headers=headers,
                )

            m_mem = await run_scenario(client, name="Scenario 3: Memory V3 Operations", total_requests=100, concurrency=10, request_func=memory_req)
            results.append(m_mem)

            # 4. Obsidian Brain Graph
            async def brain_req(cli, i):
                headers = {
                    "Authorization": "Bearer benchmark_token",
                    "X-MindPal-User-ID": f"bench_user_{i % 10}",
                    "X-MindPal-Locale": "en",
                }
                if i % 3 == 0:
                    return await cli.get("/api/brain/overview", headers=headers)
                elif i % 3 == 1:
                    return await cli.get("/api/brain/map", headers=headers)
                return await cli.post("/api/brain/context-plan", json={"query": f"stress management {i}"}, headers=headers)

            m_brain = await run_scenario(client, name="Scenario 4: Obsidian Brain Graph", total_requests=100, concurrency=10, request_func=brain_req)
            results.append(m_brain)

            # 5. Mixed Traffic Burst (500 requests concurrent)
            async def mixed_req(cli, i):
                mod = i % 4
                if mod == 0:
                    return await sync_chat_req(cli, i)
                elif mod == 1:
                    return await sse_chat_req(cli, i)
                elif mod == 2:
                    return await memory_req(cli, i)
                else:
                    return await brain_req(cli, i)

            m_mixed = await run_scenario(client, name="Scenario 5: Mixed Traffic Burst", total_requests=500, concurrency=20, request_func=mixed_req)
            results.append(m_mixed)

    return results


def print_results(results: list[BenchmarkMetrics], title: str = "Benchmark Results"):
    print(f"\n=================== {title} ===================")
    print(f"{'Scenario':<38} | {'Reqs':<5} | {'p50 (ms)':<8} | {'p95 (ms)':<8} | {'p99 (ms)':<8} | {'Req/s':<8} | {'RSS (MB)':<8}")
    print("-" * 105)
    for r in results:
        print(f"{r.scenario_name:<38} | {r.total_requests:<5} | {r.p50_ms:<8.2f} | {r.p95_ms:<8.2f} | {r.p99_ms:<8.2f} | {r.throughput_rps:<8.1f} | {r.memory_rss_mb:<8.1f}")
    print("=" * 105)


if __name__ == "__main__":
    res = asyncio.run(run_all_benchmarks())
    print_results(res, title="MindPal Backend Baseline Benchmarks")
