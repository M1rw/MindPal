# API Reference

This document enumerates the REST API endpoints provided by the MindPal backend, including HTTP methods, authentication requirements, path parameters, and request/response models.

---

## Health & System Diagnostics (`/api`)

| Method | Endpoint | Auth | Request Body | Response Model / Description |
|---|---|---|---|---|
| `GET` | `/api/health` | Public | None | `{"status": "ok", ...}` |
| `GET` | `/api/health/live` | Public | None | `{"status": "ok"}` |
| `GET` | `/api/health/ready` | Public | None | `{"status": "ok"}` |
| `GET` | `/api/health/diagnostics` | Public | None | `HealthResponse` |
| `GET` | `/api/rag/health` | Public | None | RAG health status object |

---

## User & Profile Management (`/api/user`)

| Method | Endpoint | Auth | Request Body | Response Model |
|---|---|---|---|---|
| `GET` | `/api/user/me` | User / Anon | None | `CurrentUserResponse` |
| `GET` | `/api/user/profile` | User / Anon | None | `UserProfileResponse` |
| `PATCH` | `/api/user/profile` | User / Anon | Partial `UserProfile` | `UserProfileResponse` |
| `PUT` | `/api/user/profile` | User / Anon | `UserProfile` | `UserProfileResponse` |
| `POST` | `/api/user/profile/reset` | User / Anon | None | `UserProfileResponse` |
| `GET` | `/api/user/analytics` | User / Anon | None | `UserAnalyticsResponse` |
| `GET` | `/api/user/export` | User / Anon | None | `dict[str, Any]` |
| `DELETE` | `/api/user/data` | User / Anon | None | `dict[str, Any]` |
| `GET` | `/api/user/insights` | User / Anon | None | `MentalHealthInsightsResponse` |
| `POST` | `/api/user/improvement-signals` | User / Anon | Signal payload | `dict[str, Any]` |
| `GET` | `/api/user/health` | Public | None | Status dict |

---

## Chat & LLM Execution (`/api/chat` & `/api/chat-store`)

| Method | Endpoint | Auth | Request Body | Response Model |
|---|---|---|---|---|
| `POST` | `/api/chat` | User / Anon | `ChatRequest` | `ChatResponse` |
| `POST` | `/api/chat/stream` | User / Anon | `ChatRequest` | EventStream (`text/event-stream`) |
| `GET` | `/api/chat/debug/{request_id}` | User / Anon | None | `ProviderChainTrace` |
| `GET` | `/api/chat-store/current` | User / Anon | None | Current chat session document |
| `PUT` | `/api/chat-store/current` | User / Anon | Session payload | Updated chat session document |
| `POST` | `/api/chat-store/current/messages` | User / Anon | `Message` payload | Updated chat session |
| `DELETE` | `/api/chat-store/current` | User / Anon | None | Clear session result |

---

## Memory & Brain Graph (`/api/memory` & `/api/brain`)

| Method | Endpoint | Auth | Request Body | Response Model |
|---|---|---|---|---|
| `GET` | `/api/memory/summary` | User / Anon | None | `MemorySummaryResponse` |
| `PUT` | `/api/memory/summary` | User / Anon | Summary update | `MemorySummaryResponse` |
| `POST` | `/api/memory/refresh` | User / Anon | None | `MemorySummaryResponse` |
| `POST` | `/api/memory/summary/refresh` | User / Anon | None | `MemorySummaryResponse` |
| `POST` | `/api/memory/reset` | User / Anon | None | `MemorySummaryResponse` |
| `POST` | `/api/memory/summary/reset` | User / Anon | None | `MemorySummaryResponse` |
| `GET` | `/api/memory/nodes` | User / Anon | None | `List[MemoryAtom]` |
| `DELETE` | `/api/memory/nodes/{node_id}` | User / Anon | None | `MemoryGraphLoadResult` |
| `DELETE` | `/api/memory/all` | User / Anon | None | `MemoryWriteResult` |
| `PATCH` | `/api/memory/settings` | User / Anon | Settings patch | Status dict |
| `GET` | `/api/memory/provenance/{response_id}` | User / Anon | None | `MemoryProvenanceResponse` |
| `GET` | `/api/memory/v3` | User / Anon | None | `MemoryGraphLoadResult` |
| `PUT` | `/api/memory/v3` | User / Anon | Memory Graph payload | `MemoryGraphWriteResult` |
| `PATCH` | `/api/memory/v3` | User / Anon | Graph delta | `MemoryGraphLoadResult` |
| `DELETE` | `/api/memory/v3/items/{atom_id}` | User / Anon | None | `MemoryGraphLoadResult` |
| `POST` | `/api/memory/v3/merge` | User / Anon | Merge payload | `MemoryGraphLoadResult` |
| `POST` | `/api/memory/v3/migrate` | User / Anon | Migration payload | `MemoryGraphLoadResult` |
| `GET` | `/api/memory` | User / Anon | None | `MemoryLoadResult` |
| `POST` | `/api/memory/summarize` | User / Anon | Summarize options | `MemoryCompactionResult` |
| `PUT` | `/api/memory` | User / Anon | Legacy memory payload | `MemoryWriteResult` |
| `DELETE` | `/api/memory` | User / Anon | None | `MemoryWriteResult` |
| `GET` | `/api/brain/overview` | User / Anon | None | `BrainOverview` |
| `GET` | `/api/brain/map` | User / Anon | None | `BrainMapView` |
| `GET` | `/api/brain/nodes/{atom_id}` | User / Anon | None | `BrainFocusView` |
| `GET` | `/api/brain/search` | User / Anon | `q` query string | `list[BrainNodeView]` |
| `POST` | `/api/brain/edges` | User / Anon | Edge definition | `BrainMutationResponse` |
| `PATCH` | `/api/brain/edges/{edge_id}` | User / Anon | Partial edge payload | `BrainMutationResponse` |
| `DELETE` | `/api/brain/edges/{edge_id}` | User / Anon | None | `BrainMutationResponse` |
| `POST` | `/api/brain/review/{review_id}` | User / Anon | Review decision | `BrainMutationResponse` |
| `POST` | `/api/brain/context-plan` | User / Anon | Context options | `BrainContextPack` |

---

## Features & Admin (`/api/feature` & `/api/admin/features`)

| Method | Endpoint | Auth | Request Body | Response Model |
|---|---|---|---|---|
| `GET` | `/api/feature` | Public / User | None | `FeatureSnapshotResponse` |
| `GET` | `/api/feature/changelog` | Public / User | None | `ChangelogResponse` |
| `POST` | `/api/feature/changelog/dismiss` | User / Anon | Dismiss payload | Status dict |
| `GET` | `/api/admin/features` | Admin | None | `AdminFeatureListResponse` |
| `PATCH` | `/api/admin/features/{feature_key}` | Admin | Partial policy | `AdminFeaturePolicyResponse` |
| `PUT` | `/api/admin/features/{feature_key}` | Admin | Full policy | `AdminFeaturePolicyResponse` |

---

## Safety, Tools, TTS, Voice & Notifications

| Method | Endpoint | Auth | Request Body | Response Model |
|---|---|---|---|---|
| `POST` | `/api/safety/classify` | User / Anon | Classification input | `SafetyClassifyResponse` |
| `POST` | `/api/safety/render-crisis-response` | User / Anon | Template parameters | `CrisisResponseTemplateView` |
| `GET` | `/api/safety/health` | Public | None | Status dict |
| `POST` | `/api/tools/execute` | User / Anon | Tool execution request | `ToolExecutionResponse` |
| `POST` | `/api/tools/batch` | User / Anon | Batch tool requests | `BatchToolResponse` |
| `GET` | `/api/tools/list` | User / Anon | None | List of available tools |
| `POST` | `/api/voice/v4/token` | User / Anon | Session parameters | `VoiceV4TokenResponse` |
| `GET` | `/api/notifications/settings` | User / Anon | None | `NotificationSettings` |
| `PUT` | `/api/notifications/settings` | User / Anon | Updated settings | `NotificationSettings` |
| `POST` | `/api/tts/synthesize` | User / Anon | `TTSRequest` | `TTSResponse` |
| `POST` | `/api/tts/policy` | User / Anon | Policy query | `TTSPolicyResponse` |
| `GET` | `/api/tts/health` | Public | None | Status dict |
| `GET` | `/api/favicon` | Public | `domain` query param | Redirect / Favicon stream |
