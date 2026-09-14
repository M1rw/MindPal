# MindPal documentation

Operating manual for the current tree. Historical audits, sprint logs, and research dumps live in [`archive/docs-historical/`](../archive/docs-historical/).

MindPal is a production wellness companion: FastAPI, Firebase Auth, Memory Graph, and a React client in `frontend/src/`.

## Index

### Architecture
- [`architecture/backend-platform.md`](architecture/backend-platform.md) — current backend constitution
- [`architecture/frontend-platform.md`](architecture/frontend-platform.md) — current frontend stack and invariants
- [`architecture/memory_v4_design.md`](architecture/memory_v4_design.md)
- [`ARCHITECTURE_MAP.md`](ARCHITECTURE_MAP.md), [`ENTRY_POINTS.md`](ENTRY_POINTS.md), [`STACK.md`](STACK.md), [`DATA_MODEL.md`](DATA_MODEL.md)

### Product
- [`product/current-state-and-roadmap.md`](product/current-state-and-roadmap.md)
- [`product/response-modes.md`](product/response-modes.md)
- [`product/mindpal-safe-mode-architecture.md`](product/mindpal-safe-mode-architecture.md)

### Backend
- [`backend/safety-system.md`](backend/safety-system.md)
- [`backend/rag-clinical-frameworks.md`](backend/rag-clinical-frameworks.md)
- [`backend/memory-v3.md`](backend/memory-v3.md) (v2 is legacy reference)
- [`backend/chat-sync-and-history.md`](backend/chat-sync-and-history.md)
- [`backend/tool-framework.md`](backend/tool-framework.md)
- [`backend/prompt-engineering.md`](backend/prompt-engineering.md)
- [`backend/quota-enforcement.md`](backend/quota-enforcement.md)
- [`LLM_PIPELINE.md`](LLM_PIPELINE.md), [`API_REFERENCE.md`](API_REFERENCE.md), [`API_CONTRACT_MATRIX.md`](API_CONTRACT_MATRIX.md)

### Frontend
- [`FRONTEND_MAP.md`](FRONTEND_MAP.md) — current React surface inventory
- [`frontend/welcome-screen.md`](frontend/welcome-screen.md)
- [`frontend/chat-display.md`](frontend/chat-display.md)
- [`frontend/model-mode-selector.md`](frontend/model-mode-selector.md)
- [`frontend/settings-ui.md`](frontend/settings-ui.md)
- [`frontend/pwa-viewport-safearea.md`](frontend/pwa-viewport-safearea.md)
- [`frontend/voice-and-mobile-ios.md`](frontend/voice-and-mobile-ios.md)

### Ops and tests
- [`ops/release-and-deploy-flow.md`](ops/release-and-deploy-flow.md)
- [`testing/regression-checklist.md`](testing/regression-checklist.md)
- [`production_engineering_standards.md`](production_engineering_standards.md)
- [`legal_pages.md`](legal_pages.md)

## Rules

1. Keep voice, auth, providers, RAG, memory, and chat sync as separate systems.
2. Do not use raw chat history as durable memory, or RAG corpus files as user memory.
3. Safety routing overrides user mode preferences.
4. Do not show a control that the backend cannot honor.
5. Settings destructive actions respond only to the explicit confirm control.
6. Viewport height uses `dvh` plus `--app-height` fallback; respect safe areas.
7. Copy visible assistant text only — never thought chains.
