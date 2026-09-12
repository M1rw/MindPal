# MindPal Backend Engineering Constitution & Platform Architecture

**Status:** Platform Rebuild & Constitution active (v5.0.0)
**Supersedes:** `backend/api` + `backend/features` dual trees, and legacy `docs/architecture/system-overview.md`
**Archived legacy codebase:** `archive/backend-legacy-2026-09-10/`

---

## Executive Summary & Google/OpenAI Engineering Paradigm

MindPal's backend platform is designed according to **tier-1 production software engineering principles** observed across major platforms (Google AIP, Stripe API standards, OpenAI API Platform, AWS Smithy).

A software product's transition from hobby/prototype grade to enterprise production grade is not merely about using modern frameworks (like FastAPI); it is defined by **strict structural invariants, zero contract drift, absolute separation of concerns, and deterministic resource lifecycle management**.

This engineering constitution defines the non-negotiable architectural laws, design patterns, failure mode post-mortems, and deployment standards for the MindPal backend.

---

## 1. Deep Audit & Post-Mortem of the Legacy Backend Architecture

An exhaustive top-to-bottom audit of `archive/backend-legacy-2026-09-10/` revealed severe architectural flaws that resulted in technical debt, security vulnerabilities, latency spikes, and developer friction.

### 1.1 Dual-Tree Codebase Fragmentation (`backend/api` vs `backend/features`)
* **Legacy Flaw:** The codebase maintained two competing directory hierarchies: `archive/backend-legacy-2026-09-10/api/routers/` (monolithic routers handling HTTP and business logic) and `archive/backend-legacy-2026-09-10/features/` (an incomplete second attempt at domain-driven design).
* **Consequence:** Duplicate routes were mounted (`/api/features/changelog` vs `/api/feature/changelog`), state management was fragmented across different service instances, and developers could not determine the source of truth for business logic.

### 1.2 Chat Logic Duplication & Pipeline Fragmentation
* **Legacy Flaw:** `api/routers/chat.py` (26 KB) and `api/routers/chat_stream.py` (24 KB) maintained completely independent, un-unified implementations of:
  - Safety classification and crisis policy evaluations
  - Grounding / RAG corpus context retrieval
  - Quota deduction and idempotency key checks
  - Memory graph mutation and entity extraction
* **Consequence:** Feature parity was impossible. Bug fixes in streaming chat were omitted from non-streaming chat. Crisis interventions behaved differently depending on whether the client connected via SSE or POST JSON.

### 1.3 Pseudo-Streaming ("Fake SSE") Anti-Pattern
* **Legacy Flaw:** In `api/routers/chat_stream.py`, the backend frequently awaited the *entire* non-streamed response from the LLM provider, buffered the complete text, and then sliced it into artificial 96-character chunks sent over an Server-Sent Events (SSE) connection with arbitrary sleep delays.
* **Consequence:** Simulated streaming offered zero Time-To-First-Token (TTFT) improvement, added artificial latency, consumed memory buffers under high concurrency, and created a misleading client experience.

### 1.4 Route Contract Drift & Unused HTTP Dead Weight
* **Legacy Flaw:** Routers defined arbitrary HTTP endpoints (e.g., `POST /api/tools/execute`, `POST /api/safety/classify`, `POST /api/tts/synthesize`, `/api/brain/*`) directly in Python without client contracts. Many routes were mounted on the app but unused by the frontend UI, or stubbed in JS.
* **Consequence:** Exposed public Attack Surface Area (IDOR vulnerabilities, arbitrary tool execution risks), inflated OpenAPI specifications, and created maintenance overhead for dead endpoints.

### 1.5 Unbudgeted & Unbounded LLM Side-Calls
* **Legacy Flaw:** Single chat turns triggered up to 4–5 synchronous LLM calls in sequence (message understanding, dynamic taxonomy update, situational snapshot generation, clinical score evaluation, and final response generation).
* **Consequence:** Extreme TTFT (> 5–10 seconds), unpredictable cloud API usage costs, cascading rate limits, and failure vulnerability if any intermediate LLM call timed out.

---

## 2. Invariants & Architectural Laws (Non-Negotiable)

Any code change that violates these invariants **will not be merged and will fail CI**.

1. **`contracts/openapi.yaml` is the Single Source of Truth.** Python frameworks do not invent endpoints or request shapes. Every public route must be declared in OpenAPI before implementation.
2. **Single Pipeline Orchestration per Domain.** The system contains exactly **one** `ChatOrchestrator`. Sync HTTP JSON and SSE streaming endpoints adapt this orchestrator; they do not re-implement prompt assembly, safety, memory, or grounding.
3. **Thin HTTP Adapters.** HTTP files in `backend/http/` parse headers/params, enforce standard authentication, call a single domain method, and convert errors. No database queries, RAG operations, or prompt logic in `http/`.
4. **Internal Logic is Not a Public API.** Internal capabilities (safety classification, tool execution, output guarding) are domain functions executed inside `ChatOrchestrator`, not exposed as public client-facing routes unless explicitly required by a user interface product screen.
5. **No Version Sprawl in Path Names.** URLs must not contain `/v2/`, `/v3/`, or `/v4/` for new features. Schema evolution is handled via OpenAPI `info.version`, property additions, and deprecation headers/sunset dates.
6. **Real Streaming or Honest Unstreamed Responses.** Streaming responses must yield real token chunks directly from provider generators via stream-through output guards. Slicing pre-buffered strings into fake SSE frames is strictly forbidden.
7. **Strict Cost & Latency Budgets.** Default user chat turns trigger exactly **one** LLM generation call. Side tasks (memory synthesis, snapshot generation, clinical extraction) must be executed out-of-band/asynchronously or explicitly gated by operational flags.
8. **Isolated Domain Boundaries.** The `backend/domain/` directory is partitioned by context. Cross-domain dependencies must use clean interfaces.
9. **Zero-Drift CI Guardrails.** CI automatically verifies that FastAPI's runtime route catalog matches `contracts/openapi.yaml` 1:1 on every pull request.

---

## 3. Standard Target Repository Structure

```text
contracts/                     # Single source of truth (OpenAPI 3.1, errors, changelog)
  openapi.yaml                 # Product API spec with x-mindpal extensions
  changelog.json               # Product release history (served byte-for-byte by API)
  errors.yaml                  # Stable error code mapping -> HTTP status
  README.md                    # Contract contribution guidelines

backend/
  main.py                      # App factory, middleware, lifespan (no domain logic)
  core/                        # Contract validation, base error classes
    contract.py
    errors.py
  http/                        # Thin adapters (max 150 LOC per module)
    wire.py                    # FastApi router registration & route mounting
    health.py                  # Health check & status
    release.py                 # Public release changelog & dismissal
    chat.py                    # Stream & non-stream chat adapters
    sessions.py                # Cloud conversation sessions
    identity.py                # User identity & profile export
    memory.py                  # Memory graph operations
    flags.py                   # Feature flags & capabilities snapshot
    voice.py                   # Voice token authorization
    system.py                  # AI Agent Route catalog & ready probe
  domain/                      # Isolated business domain logic
    chat/
      orchestrator.py          # Unified Chat Pipeline (sync & stream)
      budget.py                # LLM execution cost/call budgeting
    memory/                    # Graph store & memory synthesis
    identity/                  # User account management & clinical profiles
    voice/                     # Voice session token management
    safety/                    # Safety classification & output guards
    grounding/                 # RAG corpus loader & retrieval
    quota/                     # Quota consumption & idempotency
    release/                   # Changelog domain logic
    flags/                     # Feature flag evaluation
  infra/                       # External platform integrations (Zero HTTP knowledge)
    llm/                       # Provider gateways (Gemini, OpenRouter, Groq)
    store/                     # Storage abstractions (Firestore, Supabase, InMemory)
    auth/                      # Firebase Auth & AppCheck verifiers
  data/                        # Static datasets (crisis YAML, RAG corpus)
```

---

## 4. End-to-End Execution Lifecycles

### 4.1 Unified Chat Execution Lifecycle

```text
Client (Web / Mobile)
   │
   ▼
[ HTTP Adapter: backend/http/chat.py ]
   │ 1. Verify Bearer Auth & AppCheck Token
   │ 2. Check Quota / Idempotency Key
   │ 3. Construct ChatRequest Domain Object
   ▼
[ Domain: backend/domain/chat/orchestrator.py ]
   │
   ├──► 1. Safety Policy Check (backend/domain/safety/classify.py)
   │       └── If Crisis: Return Instant Crisis Response (Bypass LLM, Refund Quota)
   │
   ├──► 2. Load Context & Memory (backend/domain/memory/)
   │       └── Load Active Memory Graph & User Preferences
   │
   ├──► 3. Retrieve Grounding Context (backend/domain/grounding/)
   │       └── Bounded Vector/Lexical RAG Search over Clinical Corpus
   │
   ├──► 4. Build System Prompt (backend/domain/chat/prompt_builder.py)
   │       └── Assemble Base Tier Prompt + Personalization + Safety Rules
   │
   ├──► 5. Execute LLM Provider Stream (backend/infra/llm/gateway.py)
   │       └── Call Provider (e.g. Gemini 2.5 / Groq) -> Token Stream
   │
   ├──► 6. Real-Time Output Guard (backend/domain/safety/output_guard.py)
   │       └── Sentence Buffer / Token Window Scan for Policy Violations
   │
   └──► 7. Async Side-Effects (Background Task)
           └── Extract Memory Entities & Update Graph Async (Zero added user latency)
   │
   ▼
[ HTTP SSE / JSON Stream Adapter ]
   └── Yield SSE `data: {"token": "..."}` events or return final JSON
```

---

## 5. Contract & Error Standard

### 5.1 Per-Route Metadata (`x-mindpal`)
Every route in `contracts/openapi.yaml` must define operational metadata:

```yaml
x-mindpal:
  owner: identity          # Domain owner package in backend/domain/
  status: live             # live | preview | sunset | internal
  audience: user           # user | admin | system
  ai-access: schema        # hidden | catalog | schema | invoke
  client: web              # web | none | admin
  sunset: null             # Deprecation ISO date string if applicable
  side-effects: true       # Indicates if route mutates state/quota
```

### 5.2 Structured Errors (`contracts/errors.yaml`)
Errors must map error codes to HTTP statuses deterministically. Routers raise `AppError(code="quota_exceeded")` rather than hardcoding HTTP 429 in Python code.

---

## 6. Development & Deployment Quality Gates

Before any backend code is merged to `main`, CI enforces:

1. **OpenAPI Drift Prevention:** `python scripts/check_openapi_drift.py` ensures 100% equivalence between `contracts/openapi.yaml` and mounted FastAPI routes.
2. **Changelog Version Sync:** `contracts/changelog.json` version matches `pyproject.toml` version.
3. **HTTP Adapter Line Limit:** No file in `backend/http/` exceeds 150 lines of code.
4. **Import Boundary Linting:** `backend/http/` modules may only import from `backend/domain/` or `backend/core/`. No direct `backend/infra/` imports inside HTTP routes.
5. **Test Suite Verification:** `uv run pytest tests/` runs all unit, integration, and contract tests.
