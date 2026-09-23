# Voice Architecture Change Record

Date: 2026-09-22

This document records the production-grade voice architecture implemented in MindPal. It is the cross-cutting index for the backend, frontend, privacy, operations, contracts, and verification work.

## Scope

The voice subsystem now treats live voice as a governed product feature rather than a UI overlay. The system owns:

- guest and account entitlements
- server-side reservations and settlement
- live provider selection and health
- safety verification and crisis state transitions
- telemetry, retention, export, and deletion
- owner analytics and internal support diagnostics
- frontend call runtime, audio-rate presence, UI state, and redacted traces

## Change Inventory

### Backend organization

- Voice domain modules live under `backend/domain/voice/`.
- Safety modules live under `backend/domain/safety/`.
- HTTP adapters are split between:
  - `backend/http/voice.py`: live commands and owner trace ingestion
  - `backend/http/voice_ops.py`: owner read models and internal operations
- Runtime contracts are typed with Pydantic request and response models.
- `contracts/openapi.yaml` is checked against the live FastAPI operation set.

### Policy and quota

- `VoicePolicy` resolves guest versus account rules from validated runtime configuration.
- Guest defaults are five minutes per daily allowance.
- Account defaults are thirty minutes per daily allowance.
- Reservation, reclaim, refund, and settlement are server-owned.
- Browser-provided `used_s` values are telemetry hints, not settlement authority.

### Provider architecture

- `LiveVoiceProvider` defines the provider port.
- `GeminiLiveVoiceProvider` adapts the existing Gemini token implementation.
- `LiveVoiceCapabilities` reports supported audio, transcription, resumption, proactivity, compression, safety, and voices.
- `LiveVoiceHealth` reports status, latency, circuit state, and failure information.
- `LiveVoiceCircuit` prevents repeated calls to an unhealthy provider.
- `LiveVoiceProviderRouter` supports declared fallback order.

### Safety and lifecycle

The primary lifecycle is:

```text
mint -> warm -> listening/speaking -> renew or reconnect -> teardown
```

Safety actions are separate from ordinary floor state:

- `continue`: normal conversation
- `stay_support`: elevated distress support while the call remains active
- `escalate_pause`: speak-first or terminal pause behavior
- `crisis_freeze`: terminal server-side freeze state
- `safety_unverified`: control-plane verification did not complete

### Privacy lifecycle

Retention is intentionally separated by data class:

| Data class | Policy | Export behavior |
| --- | --- | --- |
| Raw session/transcript buffers | 30 days | Not exported |
| Safety telemetry | 90 days | Sanitized events only |
| User-facing summaries | Chat-history policy | Exported through chat history |
| Idempotency claims | 24 hours | Not exported |
| Audio | Never recorded server-side | Not applicable |

The scheduled worker is `backend/tools/voice_retention.py`. Vercel runs the protected route `/api/internal/voice-retention` daily at 03:00 UTC.

Account export and deletion are integrated through `IdentityService` and `VoicePrivacyService`.

### Telemetry and operations

There are two observability layers:

1. Session telemetry: durable, session-scoped events in `voice_telemetry`.
2. Operational metrics: bounded counters and latency totals through `VoiceMetrics`.

Production can attach `StoreMetricsExporter`; local development keeps process-local counters and structured logs.

Tracked operational outcomes include:

- request latency
- quota exhaustion
- reconnect and renewal
- provider failures
- safety classifier failures
- teardown reasons
- retention and diagnostics operations

No transcript, token, user identifier, or provider response body is used as a metric label.

### Owner and support surfaces

Owner-facing routes:

- `GET /api/voice/usage`
- `GET /api/voice/analytics`
- `GET /api/voice/audit`
- `POST /api/voice/trace`

Internal support routes:

- `GET /api/internal/voice-diagnostics/{session_id}`
- `POST /api/internal/voice-diagnostics`
- `GET /api/internal/voice-retention`

The owner audit is authenticated with the caller's account. Support diagnostics require `MINDPAL_VOICE_SUPPORT_DIAGNOSTICS_SECRET`. Retention requires `MINDPAL_VOICE_RETENTION_CRON_SECRET` or the scheduler bearer credential.

Client traces are recursively redacted before upload. Server diagnostics include the request ID for incident correlation.

## Frontend Feature Boundary

The public voice package exposes explicit feature-family barrels:

- `frontend/src/voice/session/`: captions, opener context, and session-facing helpers
- `frontend/src/voice/runtime/`: `LiveVoiceSession`, call machine, and narrow ports
- `frontend/src/voice/safety/`: crisis UX, enforcement, lexicon, and risk rating
- `frontend/src/voice/diagnostics/`: flight recorder, analysis, redaction, download
- `frontend/src/voice/ui/`: voice overlay, transcript, and presence presentation
- `frontend/src/voice/api.ts`: voice API boundary and error classification
- `frontend/src/voice/store.ts`: discrete Zustand state boundary
- `frontend/src/voice/presenceBus.ts`: high-rate audio and affect signals outside React state

Zustand owns stable UI state only. Mic energy, playback energy, prosody, affect, backchannel, and distress signals use `presenceBus`.

## Verification

The current implementation has the following verified checks:

- architecture and OpenAPI drift gate passes
- full Python suite passes
- voice lifecycle suite covers mint, warm, renew, teardown, reclaim, quota, safety, fallback, privacy, and duplicate events
- frontend production bundle builds successfully
- diff hygiene passes apart from existing Windows LF/CRLF normalization warnings

FastAPI currently emits four deprecation warnings for the existing `on_event` startup hook. They do not fail the suite.

## Key Files

- `backend/domain/voice/services/session.py`
- `backend/domain/voice/privacy.py`
- `backend/domain/voice/providers/live.py`
- `backend/domain/voice/providers/gemini/live.py`
- `backend/domain/voice/telemetry.py`
- `backend/http/voice.py`
- `backend/http/voice_ops.py`
- `frontend/src/voice/runtime/index.ts`
- `frontend/src/voice/diagnostics/trace.ts`
- `frontend/src/voice/store.ts`
- `contracts/openapi.yaml`
- `tests/unit/platform/test_voice_lifecycle.py`
