# MindPal Backend V2 architecture

## Request boundary

Every request receives a sanitized correlation ID, strict body-size enforcement, no-store API caching, trusted-host/CORS enforcement, structured logging without raw prompts, and centralized exception translation. Production starts only when fail-closed configuration validation succeeds.

Authenticated product routes require both:

1. a verified Firebase ID token; and
2. a verified Firebase App Check token supplied in `X-Firebase-AppCheck`.

Admin diagnostics additionally require the verified Firebase custom claim `mindpal_admin=true`.

## Composition root

`backend/api/dependencies.py` owns one lazy `ServiceContainer` per FastAPI application. It creates one pooled `httpx.AsyncClient`, provider adapters, Auth, Firestore, LLM orchestration, RAG, safety, output guard, TTS, quotas, rate limits, idempotency, and the canonical memory repository. The application lifespan closes its own pool. Tests can construct isolated applications from explicit `Settings` without global-environment leakage.

## Paid-operation transaction

```text
Firebase Auth + App Check
        │
        ▼
Distributed rate limit + per-user concurrency
        │
        ▼
Idempotency claim (request/payload ownership)
        │
        ▼
Atomic quota reservation
        │
        ▼
Safety → bounded context/RAG/tools → provider gateway → output guard
        │
        ├── success: commit quota + complete idempotency
        └── failure: refund quota + release idempotency claim
```

Stale quota reservations are refunded automatically. Reused idempotency keys with different payloads fail with 409. Oversized responses are never placed in replay documents.

## Canonical memory

`MemoryRepository` makes Memory Graph V3 the sole writable state:

```text
memory_graphs/{user_id_hash}
  version
  atoms[]
  full_snapshot
  created_at
  updated_at
```

All merge, patch, delete, replacement, migration, and legacy compatibility paths converge on Firestore transactions. Full replacement supports optimistic version checks. Legacy summaries are derived views, not an independently writable store. Documents are compacted below a conservative Firestore size ceiling while preserving pinned, active, identity, people, safety-context, and higher-confidence atoms first.

## Chat persistence

Chat append and profile updates are transactional. Voice-call messages pass through an explicit bounded schema; arbitrary nested client objects are discarded. Chat history and idempotency payloads are compacted before Firestore writes.

## Voice

The permanent Gemini key never reaches the browser. `/api/voice/token` creates a short-lived Gemini Live ephemeral token after Auth, App Check, rate-limit, idempotency, and quota checks. The retired `/api/voice/key` route returns 410. Browser reconnects refresh Firebase ID and App Check tokens together.

## Deployment model

The same FastAPI app serves API routes, generated runtime browser configuration, and built frontend assets locally and on Vercel. Runtime config contains public Firebase web identifiers and App Check site key only; server credentials and provider keys are never serialized.
