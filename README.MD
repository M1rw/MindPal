# MindPal

MindPal is an AI-powered mental health support application featuring a production-oriented FastAPI/Firebase backend, canonical Memory Graph V3, and Gemini Live Voice V3 full-duplex conversational audio interface.

## System Architecture

```text
Browser Client
  ├─ Firebase Auth ID token
  ├─ Firebase App Check token
  └─ request ID / idempotency key
          │
          ├─────────────────────────────────────────────┐
          ▼                                             ▼
FastAPI Request Boundary                     Gemini Live API (Voice V3)
  ├─ Security / Host / CORS / Headers             ├─ Ephemeral single-use token via /api/voice/v4/token
  ├─ Authentication & App Check Attestation       ├─ wss://generativelanguage.googleapis.com/...
  ├─ Quota & Rate Limit Enforcement               ├─ BidiGenerateContentConstrained endpoint
  ├─ Bounded Orchestration & Provider Gateway     ├─ Direct full-duplex 16kHz in / 24kHz out audio
  └─ Canonical Memory Graph V3 Persistence        └─ AudioWorklet PCM streaming & caption sync
```

The permanent Gemini API credentials remain strictly server-side. Voice sessions use short-lived single-use ephemeral tokens.

---

## Backend Architecture & Domain Structure

The MindPal backend uses a domain-driven, single-responsibility architecture:

```text
backend/
├── core/                  # Infrastructure foundations (config, errors, logging, security, validation, freshness, url_validator)
├── api/                   # Thin, versioned FastAPI routers delegating to domain services
│   ├── dependencies.py    # Centralized FastAPI Dependency Injection & RequestContext
│   ├── chat_router.py     # Thin chat completion route
│   ├── chat_stream_router.py # Thin SSE streaming chat route
│   ├── memory_router.py   # Memory Graph V3 endpoints
│   ├── brain_router.py    # Obsidian Brain graph endpoints
│   └── ...                # user, safety, tts, tools, feature, health, voice_v4, chat_store, favicon
├── services/
│   ├── bootstrap/         # Composition root and container builder
│   ├── core/              # Shared infrastructure (circuit_breaker, cache, metrics, health, sharding)
│   └── domain/            # Single-responsibility domain services
│       ├── llm/           # Provider gateway, tool_orchestrator, chat_orchestrator, response_parser
│       ├── safety/        # Rule compiler, classifier, crisis templates, safety policy
│       ├── memory/        # Extraction, compaction, graph_service
│       ├── rag/           # Corpus retriever, planner
│       ├── voice/         # Voice policy & V4 token service
│       ├── features/      # Feature flags, policy store, evaluation
│       ├── quota/         # Quota service, rate limiter, idempotency
│       ├── intelligence/   # Clinical profile extractor, reply finalizer, response intelligence
│       └── admin/         # Supabase admin authority
└── models/                # Typed Pydantic domain models
```

---

## Key Features

- **Voice System V3/V4**: Real-time full-duplex conversational voice powered by Google Gemini Live API (`gemini-2.5-flash-native-audio-latest`).
- **Memory Graph V3**: Canonical, deterministic memory graph store for user profile, preferences, relationship context, and coping patterns.
- **FastAPI / Firebase Backend V2**: Rate-limited, idempotency-guaranteed, quota-enforced API infrastructure with Firebase Auth and App Check attestation.
- **Obsidian Brain**: Policy-filtered visual knowledge graph with interactive context planning.
- **Responsive Web UI**: Built with Tailwind CSS and ESBuild for high performance across desktop and mobile devices.

---

## Local Setup & Development

### Prerequisites
- Python 3.12+
- Node.js 20+

### Setup Instructions

```bash
# Sync Python dependencies with uv
uv sync --extra dev

# Install Node dependencies
npm install

# Build frontend assets
npm run build
```

### Running Locally

```bash
uv run python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

---

## Verification & Testing

MindPal features full test suites across Python and JavaScript layers:

```bash
# Run Python backend tests (unit + integration + contract + edge cases + weirdness)
uv run --frozen pytest

# Run JavaScript frontend & Voice tests
npm test

# Run realistic performance benchmark
uv run python scripts/benchmark_scenarios.py

# Build all frontend and Voice assets
npm run build:vercel

# Verify prebuilt frontend assets
uv run python scripts/verify_frontend_build.py
```

---

## Vercel Deployment

Deployment to Vercel runs `npm ci && npm run build:vercel && python scripts/verify_frontend_build.py`. The FastAPI application serves those generated files after the build completes.
