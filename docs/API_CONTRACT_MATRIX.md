# API Contract Matrix (Frontend ↔ Backend)

## Overview & Alignment Verification

This contract matrix compares every frontend network call against the corresponding backend API endpoint implementation to identify contract mismatches, parameter discrepancies, missing routes, and unhandled errors.

---

## Contract Verification Matrix

| Call Location | Method | Frontend Path / Endpoint | Backend Target Endpoint | Status | Discrepancy / Alignment Analysis |
|---|---|---|---|---|---|
| `frontend/js/services/api.js` | `POST` | `/api/chat` | `/api/chat` | ✅ Matched | Payload `ChatRequest` and response `ChatResponse` align cleanly. |
| `frontend/js/services/api.js` | `POST` | `/api/chat/stream` | `/api/chat/stream` | ✅ Matched | SSE event streaming types align. |
| `frontend/js/services/api.js` | `GET` | `/api/user/profile` | `/api/user/profile` | ✅ Matched | Model schema `UserProfileResponse` matches client parser. |
| `frontend/js/services/api.js` | `PATCH` | `/api/user/profile` | `/api/user/profile` | ✅ Matched | Partial profile update payload handles settings. |
| `frontend/js/ui/components/settings_ui.js` | `GET` | `/api/memory/summary` | `/api/memory/summary` | ✅ Matched | Returns `MemorySummaryResponse`. |
| `frontend/js/ui/components/settings_ui.js` | `PUT` | `/api/memory/summary` | `/api/memory/summary` | ✅ Matched | Updates summary narrative string. |
| `frontend/js/ui/components/settings_ui.js` | `POST` | `/api/memory/summary/refresh` | `/api/memory/summary/refresh` | ✅ Matched | Triggers asynchronous LLM memory graph re-synthesis. |
| `frontend/js/ui/components/settings_ui.js` | `POST` | `/api/memory/summary/reset` | `/api/memory/summary/reset` | ✅ Matched | Resets narrative summary. |
| `frontend/js/ui/components/feature_status_ui.js` | `GET` | `/api/features/changelog` | `/api/feature/changelog` | ❌ **Mismatch** | **Route Pluralization Bug**: Frontend requests `/api/features/changelog` (plural), whereas backend router registers `@router.get("/changelog")` under singular `/api/feature` prefix (`/api/feature/changelog`). |
| `frontend/js/ui/components/feature_status_ui.js` | `POST` | `/api/features/changelog/dismiss` | `/api/feature/changelog/dismiss` | ❌ **Mismatch** | **Route Pluralization Bug**: Frontend posts to `/api/features/changelog/dismiss` (plural), resulting in HTTP 404. |
| `frontend/js/ui/components/feature_status_ui.js` | `GET` | `/api/features/insights` | `/api/user/insights` | ❌ **Mismatch** | **Path Discrepancy Bug**: Frontend requests `/api/features/insights` instead of `/api/user/insights`. |
| `frontend/js/app/main.js:1547` | `POST` | `/api/voice/summarize` | None | ❌ **Missing Route** | Frontend attempts to call `/api/voice/summarize` for voice summaries, but backend has no such endpoint registered under `voice_v4.py`. |
