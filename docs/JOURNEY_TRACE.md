# Core User Journey Trace

## Overview & Sequence Diagram

This document traces the primary user journey end-to-end across both frontend UI and backend services:
`Sign In` -> `Chat Interaction` -> `Clinical Screening` -> `Next Session Continuity`.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Frontend as Frontend App (js/app/main.js & js/services/api.js)
    participant Auth as Auth Service (js/services/auth.js & Firebase)
    participant Router as Backend Router (api/routers/chat.py)
    participant Orch as LLM Orchestrator (services/domain/llm/)
    participant Memory as Memory Service (services/domain/memory/)

    User->>Frontend: Open app & click "Sign in with Google"
    Frontend->>Auth: Trigger GSI / Firebase OAuth flow
    Auth-->>Frontend: Auth ID token issued
    User->>Frontend: Send message "I'm feeling overwhelmed today"
    Frontend->>Router: POST /api/chat (Bearer Token, ChatRequest)
    Router->>Auth: Verify Auth Token -> resolve user_id
    Router->>Memory: Get Memory Graph & User Snapshot
    Memory-->>Router: Narrative summary & active profile
    Router->>Orch: build_tiered_prompt() & convert_history()
    Orch->>Orch: Call Gemini LLM API
    Orch-->>Router: LLMResponse (reply text, tokens used)
    Router->>Memory: Background Memory Extraction & Clinical Analysis
    Router-->>Frontend: ChatResponse (reply text, request_id)
    Frontend-->>User: Render reply & update chat UI
```

---

## Hand-off Protocol Details

1. **Authentication Hand-off**:
   - `frontend/js/services/auth.js` intercepts Google OAuth callback, obtains Firebase JWT, and sets `Authorization: Bearer <token>` on all outbound API requests.
   - `backend/api/dependencies.py` verifies token and populates `request.state.session.user_id_hash`.

2. **Chat Handoff**:
   - `frontend/js/services/api.js` (`sendMessage`) converts user input into `ChatRequest(message=..., history=...)`.
   - Backend `chat.py` router authenticates request, loads user snapshot and memory graph, constructs prompt via `prompt_builder.py`, and calls Gemini provider.

3. **Screening & Memory Handoff**:
   - After responding to chat, backend executes `extract_clinical_inline` and `persist_memory_graph_inline` in the background without delaying response return.
