# MindPal Backend API Controlled Load-Test Report

**Author:** Manus AI  
**Date:** 2026-08-13  
**Scope:** Local in-process FastAPI/ASGI test environment only. No request was sent to Vercel, Firebase, or an external language-model provider.

## Executive summary

MindPal’s backend was subjected to a controlled concurrent-load campaign through the real ASGI application. The campaign verified that health traffic, protected-route rejection, chat concurrency limits, and per-user chat rate limits all remain bounded under burst traffic. The test exposed one user-experience reliability issue: saturated chat requests waited for the former one-second concurrency queue timeout before returning `429`. This delay was reduced to a configurable **100 ms** queue interval for both chat routes.

After the repair, the local chat concurrency scenario admitted exactly three requests, matching the configured per-user cap, while the remaining nine requests were rejected with `429` in approximately **153 ms** at the 50th percentile. The three admitted requests completed at the expected approximately **1.2 second** controlled-provider delay. No unbounded work, limit overrun, or server error occurred in the campaign.

## Test design

The reusable harness is `scripts/load_test_backend.py`. It constructs the production application topology with test settings, in-memory persistence, and a deterministic delayed provider surrogate. Its chat scenarios traverse request parsing, authentication/session resolution, rate limiting, concurrency acquisition, idempotency, safety, RAG/prompt assembly, output validation, and SSE response generation; the only substituted dependency is the external provider call.

> The recorded numbers characterize **application behavior in this controlled local environment**, not an internet-facing capacity guarantee. Production capacity additionally depends on Vercel worker allocation, Firebase latency, database configuration, external provider latency, and network conditions.

| Scenario | Request count | Client concurrency | Intended assertion |
|---|---:|---:|---|
| Health burst | 1,000 | 100 | Middleware and health route remain available under bounded parallel traffic. |
| Protected memory baseline | 20 | 1 | Missing authentication is rejected quickly without external validation work. |
| Protected memory burst | 200 | 50 | Unauthorized requests remain fail-closed under concurrent traffic. |
| Chat concurrency limit | 12 | 12 | Per-user active chat generation is capped at the configured value. |
| Chat rate-limit burst | 20 | 20 | Per-minute chat quota admits only the configured allowance. |

## Results

| Scenario | Responses | Throughput | Overall P50 | Overall P95 | Assessment |
|---|---|---:|---:|---:|---|
| Health burst | 1,000 × `200` | 1,055.30 rps | 71.83 ms | 140.24 ms | Passed. No errors or dropped health responses. |
| Protected memory baseline | 20 × `401` | 18.70 rps | 1.58 ms | 2.05 ms | Passed. One first-request initialization outlier reached 1,036.99 ms; steady-state requests were fast. |
| Protected memory burst | 200 × `401` | 526.42 rps | 69.71 ms | 169.35 ms | Passed. All requests failed closed; no accidental anonymous access. |
| Chat concurrency limit | 3 × `200`; 9 × `429` | 9.58 rps | 153.24 ms | 1,244.84 ms | Passed. P95 includes the deliberately delayed admitted generation work. |
| Chat rate-limit burst | 5 × `200`; 15 × `429` | 245.34 rps | 75.99 ms | 78.51 ms | Passed. Exactly five requests were admitted. |

The mixed-status concurrency result must be interpreted by response class. The table below separates intended `429` overload responses from admitted chat requests.

| Scenario and status | Count | P50 latency | P95 latency | Interpretation |
|---|---:|---:|---:|---|
| Chat concurrency `429` | 9 | 152.55 ms | 155.11 ms | Prompt overload rejection after the new 100 ms queue bound plus route overhead. |
| Chat concurrency `200` | 3 | 1,244.84 ms | 1,249.05 ms | Expected completion time of the controlled 1.2-second provider surrogate. |
| Chat rate limit `429` | 15 | 73.99 ms | 78.35 ms | Fast deterministic rate-limit enforcement. |
| Chat rate limit `200` | 5 | 78.12 ms | 79.30 ms | Admission and response path stayed bounded with the immediate safe surrogate. |

## Remediation implemented

| Finding | Root cause | Repair | Verification |
|---|---|---|---|
| Overloaded chats waited too long before rejection. | Both `/api/chat` and `/api/chat/stream` requested a rate-limit concurrency permit with a hard-coded one-second acquisition timeout. Slow provider calls kept new interactive requests waiting even when they would not be admitted. | Added `CHAT_CONCURRENCY_QUEUE_TIMEOUT_SECONDS` to typed settings with a production-safe default of `0.10` seconds and applied it consistently to both chat routes. | The local burst admitted exactly 3 of 12 requests and returned 9 `429` responses with a 152.55 ms median latency. |
| Load testing was not a reusable artifact. | Earlier resilience checks covered individual components but did not provide a scenario-level API workload report. | Added `scripts/load_test_backend.py`, which records machine-readable metrics in `artifacts/backend_api_load_test.json`, including per-status latency buckets. | The harness completed all five scenarios without external network activity. |
| Short queue behavior lacked a direct regression test. | The existing concurrency test proved a cap but allowed a two-second waiting policy. | Added `test_concurrency_guard_rejects_within_short_queue_timeout`. | Targeted adversarial resilience suite: 23 passed. |

## Final validation

The full production verification pipeline passed after the load-control change. It completed **89 Python tests**, **17 JavaScript tests**, Ruff static analysis, Bandit security analysis, frontend delivery auditing, configuration and OpenAPI smoke tests, prebuilt asset validation, and Node/Python production dependency audits. The targeted adversarial resilience suite also completed with **23 passing tests**.

## Operational recommendations

The new setting should remain short for interactive chat because an application-level queue cannot make a delayed provider faster; it only delays the user’s overload signal. A value between **0.05 and 0.25 seconds** is suitable for an interactive API, while a longer value should be used only if a deliberately queued experience is introduced with client-visible queue status.

Production monitoring should record chat admission, completion, `429` rejection, provider latency, and queue-wait duration separately. An aggregate P95 can be misleading when it mixes deliberately rejected requests with long-running successful generations. The included harness provides the same separation for repeatable local checks.
