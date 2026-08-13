# MindPal Comprehensive Production-Readiness Test Matrix

**Author:** Manus AI  
**Date:** 2026-08-13  
**Purpose:** Define the bounded, repeatable sandbox scenarios required to assess every implemented MindPal product feature and its frontend-to-backend contracts.

## Scope and quality standard

MindPal is a wellness-support application. Its quality gate is not merely whether a route returns a successful status; every feature must preserve user state, respect authentication and safety boundaries, fail visibly and recoverably, avoid duplicate side effects, and remain compatible with the deployed static frontend contract.

The matrix covers all **implemented** product features visible in the repository. It cannot prove behavior of external dependencies under every real-world condition; therefore Firebase, Vercel, microphone hardware, browser speech synthesis, and remote providers are represented by controlled fakes or local app settings when a live production call would expose user data, incur costs, or produce nondeterministic results.

## Feature inventory and scenarios

| Domain | Frontend responsibility | Backend responsibility | Mandatory sandbox scenarios | Initial coverage state |
|---|---|---|---|---|
| Bootstrap and runtime configuration | Loader, viewport sizing, theme startup, runtime configuration, static assets | Runtime config route, UI fallback, security headers | First load; missing runtime config; module failure; loader timeout; static asset manifest verification | Partial; deployment verifier exists, browser-startup recovery needs focused coverage |
| Text chat | Input validation, keyboard send, optimistic message, model/mode selection, stream rendering, abort, retry, copy, regenerate, export | `/api/chat`, `/api/chat/stream`, idempotency, quota, concurrency, LLM orchestration, output guard | Standard response; stream frame fragmentation; pre-output network retry; partial-output failure; cancellation; duplicate submission; payload bounds; provider failure; deterministic safety response; multilingual message | Strong core coverage; non-streaming route and UI state transitions need integrated coverage |
| Chat persistence | Local history, rehydration, local/cloud merge, delete, export | `/api/chats/current` get/replace/append/delete | Offline queue; duplicate merge; message-order tie; retry after token failure; clear/new chat during sync; cloud version conflict | Partial; merge helpers covered, API workflow coverage absent |
| Memory Brain / Memory V3 | Local graph extraction, inspector, edit/delete/pin/category actions, local persistence, cloud synchronization | `/api/memory/v3` get/replace/patch/delete/merge/migrate plus legacy summary endpoints | Empty graph; local extraction; edit and delete; conflict merge; migration; malformed storage; version mismatch; offline recovery; memory disabled preference; unauthorized access | Strong service coverage; frontend inspector and complete API workflow require additional tests |
| Safety and wellness boundaries | Crisis UI toggle, safety lock, crisis rendering, safe visual feedback | Input classification, crisis templates, safety event persistence, output guard | English, Arabic, and mixed-language input; injection wrapper; self-harm crisis; false positive exclusions; unsafe provider output; unsafe rewrite; request limits; unauthorized diagnostic access | Strong deterministic safety coverage; route contract coverage incomplete |
| RAG and tools | Display metadata and grounded behavior where applicable | RAG retrieval, tool registry, tool execution/batch, URL validation, time context | Empty retrieval; indirect prompt injection; private URL/SSRF rejection; valid time query; tool error; batch partial failure; auth restrictions; malformed parameters | Service tests exist; tools API route coverage incomplete |
| Authentication and cloud profile | Firebase state listener, Google sign-in UI, token retrieval, profile display, local fallback | Firebase session verification, App Check, `/api/user/me`, profile get/patch/put/reset | Unconfigured Firebase; unauthenticated guest; token failure; invalid bearer; App Check failure; sign-out during hydration; profile conflict and reset; local fallback | Helper coverage exists; complete UI and route scenarios incomplete |
| Settings and personalization | Theme, language, communication style, directness, custom instructions, mode/model selector, keyboard shortcuts | Profile preference persistence and chat metadata interpretation | Valid choices; malformed stored value; offline setting change; cloud persistence failure; profile reload; metadata round trip; mobile selector | Partial; components need isolated browser-state tests |
| Usage, streak, mood, and notifications | Mood action, weekly tracker, usage rendering, notifications, streak modal | Usage quota mirror and profile update | First-use state; quota update from metadata; exhausted allowance; malformed local state; notification permission denial | Limited automated coverage |
| Voice input and live voice | Permission state, microphone UI, ephemeral token, WebSocket lifecycle, transcript display, voice-call card, summary, reconnection, visualizer | `/api/voice/token`, `/transcribe`, `/summarize`, legacy-key retirement, rate/quota policy | Token success/401 refresh/missing fields; socket open/message/close; transient reconnect; permanent close; microphone denial; start/stop idempotency; transcript persistence; summary failure; no-transcript card; Arabic transcript; disabled voice configuration | Good helper/security coverage; full lifecycle integration requires controlled fakes |
| TTS | Speak/cancel/copy fallback and locale decision | `/api/tts/synthesize`, `/policy`, health, provider policy | Browser fallback; disabled TTS; unsafe text; response limit; unsupported locale; provider failure; cancellation | Route coverage absent |
| API health and observability | User-visible fallback only | Health/live/ready/diagnostics/RAG health, request IDs, error envelope, no-cache policy | Steady health, burst, readiness under failed dependency, detailed health authorization, request ID propagation, error shape consistency | Health and load coverage exists; diagnostic authorization needs coverage |
| Delivery and security | CSP-compatible module delivery, HTML/CSS accessibility behavior | Trusted hosts, CORS, request body limits, rate limits, headers, OpenAPI | Prebuilt drift; dependency lock drift; CSP static scan; oversized payload; CORS disallowed origin; concurrent burst; route validation; production configuration | Strong verification exists; route-level integration to be extended |

## Acceptance scenarios by outcome class

Each feature is assessed across the following outcome classes, rather than only a happy-path unit test.

| Class | Objective | Examples |
|---|---|---|
| Correct path | Verify the intended feature behavior and persisted output. | A safe chat produces a response, metadata, local history, and exactly one cloud sync entry. |
| Boundary and validation | Verify malformed, oversized, unsupported, and unauthorized inputs fail predictably. | An oversized prompt, bad locale, invalid model selection, or missing auth token returns a structured rejection. |
| Dependency failure | Verify unavailable network, provider, token, storage, or microphone input yields a recoverable user state. | Voice token timeout restores the start button; cloud sync retains local messages and retries. |
| Concurrency and idempotency | Verify duplicate work does not create duplicate charges, messages, or memory. | Repeated chat request IDs replay safely; concurrent memory writes merge or conflict cleanly. |
| Safety and privacy | Verify a user cannot escape safety logic or cross identity boundaries. | Crisis text cannot be weakened by jailbreak framing; one profile cannot retrieve another user's chat. |
| Cross-language | Verify English, Arabic, and automatic locale handling preserve policy and rendering behavior. | Arabic crisis output is routed correctly; mixed-language input does not disable safety. |
| Recovery and restart | Verify state survives page refresh, local-storage corruption, interrupted stream, and sign-in transition. | A reconnecting app restores local chat and then merges cloud chat without duplicates. |

## Test execution architecture

| Layer | Method | Why it is used |
|---|---|---|
| Pure frontend state | Node test runner with mocked browser globals | Fast deterministic coverage for selectors, serialization, merge logic, retry policy, and view-state resolution. |
| Frontend module integration | Controlled DOM/browser simulation and static bundle checks | Verifies user-event state transitions without using a real user account. |
| Backend service | Pytest with in-memory database and deterministic fake providers | Exercises validation, safety, idempotency, quota, memory, and tool behavior without live costs. |
| Backend API integration | `httpx.ASGITransport` against the real FastAPI app | Verifies route registration, middleware, headers, dependencies, error envelopes, and JSON/SSE contracts. |
| Voice lifecycle | Faked media devices, WebSocket, token endpoint, and transcript services | Covers browser-only state transitions that cannot be deterministically reproduced with real hardware. |
| Performance and abuse control | Local bounded concurrent campaigns | Confirms rate/concurrency caps without stress-testing the deployed user-facing service. |
| Delivery | Frontend build, immutable manifest verifier, configuration/OpenAPI smoke test | Ensures source changes can be shipped safely to Vercel. |

## Exit criteria

The comprehensive audit may be marked complete only after the following conditions are met.

| Criterion | Required evidence |
|---|---|
| Every inventory domain has a documented scenario result. | Updated final quality report with feature-level result, known limitation, or remediation. |
| Every reproducible defect has a regression test before or with its repair. | New or updated test file linked in the report. |
| All current tests, targeted scenario suites, static checks, dependency audits, and prebuilt verification pass. | Command logs and final verification summary. |
| No external production service is load-tested. | Harness report explicitly states local ASGI/in-memory/fake-provider scope. |
| Remaining external-dependency limits are explicit. | Firebase, live voice, browser device permissions, and remote provider production behavior listed as operational—not silently assumed—risks. |
