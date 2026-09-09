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
| `frontend/js/ui/components/feature_status_ui.js` | `GET` | `/api/feature/changelog` | `/api/feature/changelog` | ✅ Matched | Fixed in TASK-2.2: Aligned frontend endpoint to singular `/api/feature/changelog`. |
| `frontend/js/ui/components/feature_status_ui.js` | `POST` | `/api/feature/changelog/dismiss` | `/api/feature/changelog/dismiss` | ✅ Matched | Fixed in TASK-2.2: Aligned frontend endpoint to singular `/api/feature/changelog/dismiss`. |
| `frontend/js/ui/components/feature_status_ui.js` | `GET` | `/api/user/insights` | `/api/user/insights` | ✅ Matched | Fixed in TASK-2.2: Aligned frontend endpoint to `/api/user/insights`. |
| `frontend/js/app/main.js:1547` | `POST` | `/api/voice/summarize` | `/api/voice/summarize` | ✅ Matched | Fixed in TASK-2.2: Implemented authenticated `POST /api/voice/summarize` route under `backend/api/routers/voice_v4.py`. |
