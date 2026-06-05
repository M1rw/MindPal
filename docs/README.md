# MindPal Documentation

MindPal is a wellness-oriented chat product with voice input, cloud chat sync,
semantic response routing, curated RAG grounding, safety handling, and evolving
durable memory.

This folder is the operating manual for maintainers and future coding agents.
Use it before changing product logic.

Start here:

- `docs/architecture/system-overview.md`
- `docs/product/current-state-and-roadmap.md`
- `docs/backend/rag-clinical-frameworks.md`
- `docs/backend/memory-v2.md`
- `docs/backend/chat-sync-and-history.md`
- `docs/frontend/voice-and-mobile-ios.md`
- `docs/observability/debug-panel.md`
- `docs/testing/regression-checklist.md`
- `docs/ops/release-and-deploy-flow.md`

Core rules:

1. Keep voice, auth, static serving, providers, RAG, memory, and chat sync as separate systems.
2. Do not use raw chat history as durable memory.
3. Do not use RAG corpus files as user memory.
4. Do not let the LLM answer deterministic product-state questions when the app can answer them.
5. Safety routing overrides user mode preferences.
6. Egyptian Arabic input should get natural Egyptian Arabic output unless the user asks otherwise.
7. Clinical frameworks are safe technique guidance, not diagnosis, treatment, or therapy claims.

