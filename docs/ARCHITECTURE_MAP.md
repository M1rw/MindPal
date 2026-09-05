# Architecture Map

## Directory Tree & Owner Areas

```
mindpal/
├── api/                       # [infra/backend] Vercel serverless function entrypoint wrapper
├── artifacts/                 # [fixtures/testing] Test audio recordings and E2E execution log artifacts
├── backend/                   # [backend] Core Python FastAPI application codebase
│   ├── api/                   # [backend] REST API presentation layer (routers, schemas, error mapping)
│   │   ├── routers/           # [backend] FastAPI route handlers organized by domain
│   │   └── schemas/           # [backend] Pydantic request and response payload models
│   ├── core/                  # [backend] Framework-agnostic infrastructure (config, security, middleware)
│   ├── features/              # [backend] Domain feature logic modules (brain, chat, memory, safety, voice)
│   ├── models/                # [backend] Core domain models and state representations
│   ├── providers/             # [backend] External service provider integrations and adapters
│   ├── rag/                   # [backend] RAG knowledge corpus, indexing, and retrieval pipeline
│   ├── safety/                # [backend] Crisis detection, keyword matching, and safety guardrails
│   ├── services/              # [backend] Business logic services, orchestrators, and container bootstrap
│   │   ├── bootstrap/         # [backend] Dependency injection container and builder factories
│   │   ├── configs/           # [backend] Service-level configuration models
│   │   ├── core/              # [backend] Core metrics, logging, and infrastructure helpers
│   │   ├── domain/            # [backend] Subdomain logic (llm, memory, safety, voice, rag, quota)
│   │   └── shared/            # [backend] Shared utility classes and functions across services
│   └── tools/                 # [backend] LLM function calling tool specifications and handlers
├── data/                      # [fixtures/data] Static data, test personas, and clinical frameworks
│   ├── audit_fixtures/        # [fixtures] Persona JSONs, prompt dumps, and benchmark baselines
│   ├── changelog/             # [fixtures] Versioned release history JSON files
│   └── clinical_frameworks/   # [fixtures] PHQ-9, GAD-7, and clinical questionnaire definitions (YAML)
├── docs/                      # [shared/docs] Technical documentation, architecture specs, and audits
├── frontend/                  # [frontend] Client web application codebase
│   ├── assets/                # [frontend] Visual brand assets, icons, and static images
│   ├── components/            # [frontend] Modular HTML partial templates (chat, modals, settings, voice)
│   ├── css/                   # [frontend] Tailwind input stylesheet, custom rules, and compiled output
│   └── js/                    # [frontend] Client JavaScript logic (ES modules)
│       ├── app/               # [frontend] Application orchestration and event wiring
│       ├── features/          # [frontend] Feature-specific state and UI controllers
│       ├── observability/     # [frontend] Performance benchmarking and client telemetry
│       ├── services/          # [frontend] API client adapters, Firebase auth, and websocket managers
│       ├── state/             # [frontend] Global application state store and event bus
│       ├── ui/                # [frontend] UI rendering components and modal managers
│       ├── utils/             # [frontend] Client utilities, DOM helpers, and formatting logic
│       └── vendor/            # [frontend] External browser vendor scripts and Lucide icon definitions
├── scripts/                   # [infra/scripts] Build, HTML assembly, auditing, and verification utilities
├── supabase/                  # [infra/db] Database schema migrations and RLS policy SQL files
└── tests/                     # [shared/tests] Test suite (unit, integration, contract, security)
    ├── integration/           # [shared/tests] Integration, API route, and security tests
    └── unit/                  # [shared/tests] Domain logic unit tests (core, domain, memory, LLM)
```

## Owner Area Summary

- **Frontend**: `frontend/` (HTML partials, JS modules, Tailwind CSS, assets).
- **Backend**: `backend/` (FastAPI app, domain services, LLM pipelines, security, middleware).
- **Shared**: `docs/`, `tests/` (Architecture docs, unit/integration test suite).
- **Fixtures**: `data/`, `artifacts/` (Persona JSONs, clinical frameworks YAML, release logs, test audio).
- **Infra**: `api/`, `scripts/`, `supabase/`, root build configuration files.
