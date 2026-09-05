# Known Issues Registry

## Overview

This document consolidates all confirmed architectural, frontend, backend, telemetry, and contract bugs discovered during Phases 0–3.

---

## Registry of Confirmed Issues

### BUG-001: History Slicing & Duplicate Message Slicing [FIXED]
- **File & Line**: `backend/services/domain/llm/chat_orchestrator.py:382` & `backend/services/domain/llm/request_builder.py:43`
- **Severity**: High
- **Status**: FIXED
- **Description**: `convert_history` sliced `payload.history[-30:]` without stripping trailing duplicate user messages matching `payload.message`. `build_llm_request` then appended `user_message` separately, resulting in duplicate user turns. Fixed by adding duplicate stripping in `convert_history`, a defensive guard in `build_llm_request` with `history_contract_violation` event logging, and contract tests.

### BUG-002: Synthetic Memory Benchmark Metrics (`performance.memory`)
- **File & Line**: `scripts/audit/benchmark_frontend.mjs:177`
- **Severity**: Medium
- **Description**: In non-Chromium browsers or headless environments without `window.performance.memory`, mock fallback harnesses return fake 10 MB heap sizes, masking real browser memory leaks.

### BUG-003: Vercel Analytics Script 404s
- **File & Line**: `frontend/index.html:42` & `frontend/index.template.html`
- **Severity**: Low
- **Description**: Requests to `/_vercel/insights/script.js` fail with HTTP 404 in local and self-hosted environments.

### BUG-004: Root `message_count` Schema Mismatch
- **File & Line**: `data/audit_fixtures/active_persona.json:4` & `backend/models/user.py:199`
- **Severity**: Medium
- **Description**: Persona test fixtures set root-level `message_count`, but backend `UserProfile` reads message counts from `stats.total_messages`.

### BUG-005: Pluralization Discrepancy in Feature Routes (`/api/features/*` vs `/api/feature/*`)
- **File & Line**: `frontend/js/ui/components/feature_status_ui.js:77, 113` & `backend/api/routers/feature.py:139`
- **Severity**: High
- **Description**: Frontend calls pluralized paths `/api/features/changelog` and `/api/features/changelog/dismiss`, whereas backend registers singular `/api/feature/...`, causing HTTP 404 errors on changelog actions.

### BUG-006: Non-existent Voice Summary Route (`/api/voice/summarize`)
- **File & Line**: `frontend/js/app/main.js:1547`
- **Severity**: High
- **Description**: Frontend calls `POST /api/voice/summarize` for call summaries, but no corresponding route handler exists under `backend/api/routers/voice_v4.py`.

### BUG-007: Missing Telemetry Network Status Code Capture
- **File & Line**: `frontend/js/observability/neural_telemetry.js:71`
- **Severity**: Medium
- **Description**: `NeuralTelemetry` records stage names and timings but fails to capture HTTP response status codes on network failures.
