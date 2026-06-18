# MindPal Documentation

MindPal is a wellness-oriented chat product with voice input, cloud chat sync,
semantic response routing, curated RAG grounding, safety handling, and evolving
durable memory.

This folder is the operating manual for maintainers and future coding agents.
Use it before changing product logic.

## Documentation Index

### Architecture
- `docs/architecture/system-overview.md`

### Product
- `docs/product/current-state-and-roadmap.md`
- `docs/product/response-modes.md`

### Backend
- `docs/backend/rag-clinical-frameworks.md` — RAG grounding, corpus structure, retrieval flow (with diagrams)
- `docs/backend/safety-system.md` — Safety classification pipeline, crisis detection, response overrides (with diagrams)
- `docs/backend/memory-v3.md` — Adaptive Cortical Memory graph system, merge rules, lifecycle (with diagrams)
- `docs/backend/memory-v2.md` — Legacy memory system (reference only)
- `docs/backend/chat-sync-and-history.md` — Cloud chat sync via Firebase
- `docs/backend/tool-framework.md` — Server-side tool system (time, search, memory, web)
- `docs/backend/prompt-engineering.md` — System prompt construction, safety, memory, language, thought chains
- `docs/backend/quota-enforcement.md` — Credit-based rate limiting (5h + 1-week windows)

### Frontend
- `docs/frontend/welcome-screen.md` — Welcome layout, greeting logic, mood buttons, input bar
- `docs/frontend/chat-display.md` — Message rendering, copy behavior, markdown, streaming, RTL
- `docs/frontend/model-mode-selector.md` — Unified model/mode selector, locking during generation
- `docs/frontend/ui-transitions.md` — Welcome→Chat FLIP animation, loading screen, thought accordion
- `docs/frontend/pwa-viewport-safearea.md` — PWA config, viewport height fix, safe areas, standalone mode
- `docs/frontend/settings-delete-actions.md` — Delete actions safety pattern (pill-only click targets)
- `docs/frontend/voice-and-mobile-ios.md` — Voice input and mobile behavior
- `docs/frontend/voice_state_machine.md` — Voice recording state machine
- `docs/frontend/settings-ui.md` — Settings modal tabs, controls, notifications, memory inspector
- `docs/frontend/mental-health-tab.md` — Clinical insights display (PHQ-9, GAD-7, diagnoses)
- `docs/frontend/usage-and-quota.md` — Client-side usage tracking, pre-flight checks, quota banner

### Ops
- `docs/ops/release-and-deploy-flow.md`

### Observability
- `docs/observability/debug-panel.md`

### Testing
- `docs/testing/regression-checklist.md`

## Core Rules

1. Keep voice, auth, static serving, providers, RAG, memory, and chat sync as separate systems.
2. Do not use raw chat history as durable memory.
3. Do not use RAG corpus files as user memory.
4. Do not let the LLM answer deterministic product-state questions when the app can answer them.
5. Safety routing overrides user mode preferences.
6. Arabic input should get natural Arabic output unless the user asks otherwise.
7. Clinical frameworks are safe technique guidance, not diagnosis, treatment, or therapy claims.
8. Settings destructive actions respond only to the pill button, not the row text.
9. Usage credits: Standard = 1, Pro = 2×. Pre-flight check must run before every API call.
10. Model/mode selector is locked (grayed out, non-interactive) while AI is generating a response.
11. Copy button copies visible response text only, never internal thought chains.
12. Viewport height uses triple-fallback: `100vh` → `100dvh` → JS-measured `--app-height`.
