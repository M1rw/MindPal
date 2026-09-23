# Architecture

MindPal is a wellness companion: text chat and live voice, with memory that
adapts to each person. One FastAPI service on Vercel serves the API and the
built React app. Identity is Firebase Auth; application data lives in Supabase
Postgres (Firestore is a supported alternative).

## System

```mermaid
flowchart LR
    subgraph Browser["Browser (React 19, zustand, esbuild bundle)"]
        UI[Chat and memory UI]
        VC[Voice call controller]
    end

    subgraph Vercel["FastAPI on Vercel (api/index.py -> backend.main)"]
        HTTP[backend/http<br/>routes + validation]
        DOM[backend/domain<br/>chat, memory, voice, safety,<br/>adaptation, dynamic, quota, identity]
        INF[backend/infra<br/>store, llm, auth, firebase, observability]
    end

    FA[(Firebase Auth)]
    DB[(Firestore<br/>or Supabase)]
    LLM[LLM providers<br/>Gemini, OpenRouter, Groq]
    LIVE[Gemini Live API]

    UI -- "ID token, /api/*" --> HTTP
    VC -- "session-token, session-events" --> HTTP
    VC -- "ephemeral token, full-duplex audio" --> LIVE
    HTTP --> DOM --> INF
    INF --> FA
    INF --> DB
    INF --> LLM
    INF -- "mint ephemeral token" --> LIVE
```

Provider API keys never reach the browser. Live voice audio goes directly from
the browser to Gemini Live using a short-lived, single-use token minted by the
backend after quota and consent checks.

## Backend layers

| Layer | Path | Rule |
|---|---|---|
| HTTP | `backend/http/` | Request/response only. Never imports `backend.infra`; route modules stay under 150 lines (`scripts/ci/check_architecture.py`). |
| Domain | `backend/domain/` | Product behavior. One package per capability. |
| Infrastructure | `backend/infra/` | Storage providers, LLM gateway, Firebase, auth, metrics and the platform pulse. |
| Config | `backend/configs/` | `Settings` (environment, cached) plus schema-validated JSON in `configs/json/`. Nothing else reads `os.environ`. |
| Core | `backend/core/` | Errors, API contract loading, request ID context. |

Every route has an `operationId` in `contracts/openapi.yaml`. A test fails if
the served routes and the contract differ.

## A chat turn

```mermaid
sequenceDiagram
    participant C as Client
    participant H as /api/chat/stream
    participant O as ChatOrchestrator
    participant L as LLM gateway
    participant B as Background task

    C->>H: message, history, personalization
    H->>O: preflight: crisis check (message + 2 recent user turns), quota reserve
    alt crisis language
        O-->>C: crisis resources (no model call, no learning)
    else normal turn
        O->>O: adaptive profile, strategy selection,<br/>memory prompt, grounding
        O->>L: stream(system prompt, history)
        L-->>O: tokens
        O-->>C: SSE tokens (through the output guard)
        O->>O: learn style, extract facts, journal the turn
        H->>B: after the stream ends
        B->>B: memory consolidation if due and load allows
    end
```

Quota is reserved before the model call and refunded if the turn fails. Guests
are rate-limited per network; accounts have credit windows (5 hours and weekly).

## Where to read next

- [memory.md](memory.md): facts, AI summary, self-learning, privacy
- [voice.md](voice.md): live call lifecycle, quotas, safety lease
- [safety.md](safety.md): crisis handling in chat and voice
- [operations.md](operations.md): deploy, configuration, storage, load levels
- [development.md](development.md): local setup, tests, CI
