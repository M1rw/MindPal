# Backend Voice Production Architecture

## Purpose

The backend owns voice policy, live-session state, provider access, safety verification, quota settlement, privacy lifecycle, telemetry, and operational review. The browser never becomes the authority for entitlement, safety verification, or billing.

## Layered Structure

```text
HTTP adapters
    |
    +-- Voice command adapter
    |     +-- mint token
    |     +-- record events
    |     +-- reaction
    |     +-- recall
    |     +-- summarize
    |     +-- owner trace upload
    |
    +-- Voice operations adapter
          +-- owner usage
          +-- owner analytics
          +-- owner audit
          +-- scheduled retention
          +-- internal diagnostics

Domain services
    |
    +-- VoiceSessionService
    +-- VoiceAnalyticsService
    +-- VoicePrivacyService
    +-- VoiceTelemetryService
    +-- VoiceSummarizeService
    +-- VoiceUsageLifecycle
    +-- VoiceEventIdempotency

Provider port
    |
    +-- LiveVoiceProvider
          +-- GeminiLiveVoiceProvider
          +-- LiveVoiceProviderRouter
          +-- LiveVoiceCircuit

Storage and observability
    |
    +-- DocumentStore
    +-- voice_sessions
    +-- voice_minute_reservations
    +-- voice_active_sessions
    +-- voice_event_idempotency
    +-- voice_telemetry
    +-- voice_support_diagnostics
    +-- VoiceMetrics / StoreMetricsExporter
```

## Session State

A session is created by `VoiceSessionService.mint()` only after:

1. consent is attested
2. the live feature flag is enabled
3. production storage is durable
4. the server reserves available seconds
5. a provider mints a real ephemeral token

The record stores operational state, not provider credentials. The active-session row allows the server to reclaim a stale call when the caller mints again.

The main transitions are:

```text
minted -> warm -> listening <-> speaking
                    |
                    +-> stay_support
                    +-> speak_then_pause
                    +-> crisis_freeze
                    +-> torn_down
```

Renewal requires a fresh server safety lease. Teardown settles from server-observed elapsed time. Setup-failure refunds require server evidence that the call never warmed and stayed inside the setup window.

## Policy Configuration

`backend/configs/json/voice_runtime.json` is validated by `voice_runtime.schema.json` and exposed through typed runtime settings.

The policy section defines:

- guest maximum session and daily cap
- account maximum session and daily cap
- reservation and minimum session values
- reconnect permissions
- persistent-memory permissions
- fallback modes

The session section defines:

- safety lease freshness
- heartbeat interval
- abandonment windows
- provider rotation
- ledger bounds
- retention

The service layer reads typed configuration rather than embedding product limits in route code.

## Provider Port

`LiveVoiceProvider` exposes three responsibilities:

```python
capabilities() -> LiveVoiceCapabilities
health() -> LiveVoiceHealth
mint(**options) -> dict[str, Any]
```

Gemini remains the concrete implementation behind `GeminiLiveVoiceProvider`, which delegates the existing token construction and compatibility retries to `VoiceTokenService`.

The circuit breaker has three practical states:

- closed: calls are permitted
- open: calls are blocked after repeated failures
- half-open behavior: after cooldown, a call is allowed to test recovery

`LiveVoiceProviderRouter` tries providers in declared order and skips open circuits. A future provider can be added without changing `VoiceSessionService`.

## Privacy Lifecycle

`VoicePrivacyService` is the single lifecycle coordinator for voice-owned data.

### Purge

`purge_expired()` removes:

- expired voice sessions
- expired telemetry
- expired idempotency claims
- orphaned active-session pointers

The worker is safe to retry. Deployment scheduling is external because Vercel instances are ephemeral.

### Export

Voice export intentionally includes only:

- session metadata
- usage and status fields
- summary references
- sanitized safety events

Raw transcripts, ledgers, provider tokens, and audio are excluded.

### Deletion

Account deletion removes voice sessions, telemetry, idempotency, active-session, and minute-reservation records in addition to profile, memory, and chat data.

## Observability

Durable session events use `VoiceTelemetryService`. Process metrics use bounded labels:

```text
operation + outcome
```

Examples:

- `mint.quota_exceeded`
- `mint.provider_failure`
- `reconnect.success`
- `safety_classifier.safety_classifier_failure`
- `teardown:client_hangup`

The store exporter writes only bounded operational fields. Export failures are logged and isolated from the request path.

Every HTTP request receives a request ID from `backend/core/request_context.py`. Error responses, metrics, and support traces use the same correlation value.

## API Ownership

Owner APIs are authenticated with Firebase account identity and enforce ownership by `user_id_hash`.

Internal APIs are credentialed separately:

- retention uses the scheduler secret
- diagnostics use the support secret

This prevents owner-facing audit data from becoming an implicit support/admin API.

## Contract and Tests

The live route set is compared with `contracts/openapi.yaml` by `scripts/check_openapi_drift.py`.

Lifecycle coverage is in `tests/unit/platform/test_voice_lifecycle.py`. It verifies:

- mint, warm, renew, teardown
- quota exhaustion
- crisis escalation
- abandoned-session reclaim
- idempotent duplicate events
- provider circuit fallback
- privacy export and purge

## Operational Notes

- Configure `MINDPAL_VOICE_RETENTION_CRON_SECRET` in the deployment environment.
- Configure `MINDPAL_VOICE_SUPPORT_DIAGNOSTICS_SECRET` only in trusted support tooling.
- Do not place either secret in frontend configuration.
- Keep provider model and API credentials server-side.
