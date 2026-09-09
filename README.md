# MindPal

MindPal is a private AI companion for reflection, emotional clarity, voice journaling, structured memory, grounded coping tools, and context-aware support.

The product is a FastAPI backend with Firebase Auth and App Check, a canonical Memory Graph, and Gemini Live full-duplex voice. Maintainer documentation lives in [`docs/README.md`](docs/README.md).

## Architecture

```text
Browser Client
  ├─ Firebase Auth ID token
  ├─ Firebase App Check token
  └─ request ID / idempotency key
          │
          ├─────────────────────────────────────────────┐
          ▼                                             ▼
FastAPI request boundary                     Gemini Live API
  ├─ Security / CORS / headers                    ├─ Ephemeral token via /api/voice/v4/token
  ├─ Authentication & App Check                   ├─ Constrained BidiGenerateContent
  ├─ Quota & rate limits                          └─ Full-duplex PCM streaming
  ├─ Provider gateway & safety
  └─ Memory Graph persistence
```

Gemini API credentials stay server-side. Voice sessions use short-lived single-use tokens.

```text
backend/
├── core/           # Config, errors, logging, security, validation
├── api/            # Thin FastAPI routers
├── services/
│   ├── bootstrap/  # Composition root
│   ├── core/       # Cache, metrics, health, circuit breakers
│   └── domain/     # LLM, safety, memory, RAG, voice, quota, features
└── models/         # Pydantic domain models
```

## Local development

Prerequisites: Python 3.12+, Node.js 24 (npm 10).

```bash
uv sync --extra dev
npm install
npm run build
uv run python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

## Tests and verification

```bash
uv run --frozen pytest
npm test
npm run build:vercel
uv run python scripts/verify_frontend_build.py
```

## Deployment

Vercel runs `npm ci && npm run build:vercel && python scripts/verify_frontend_build.py`. FastAPI serves the generated frontend assets after that build.
