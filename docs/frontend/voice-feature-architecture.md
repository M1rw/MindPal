# Frontend Voice Feature Architecture

## Design Rule

The frontend voice feature has three different update rates and responsibilities:

1. React/Zustand state: discrete UI state and bounded transcript history.
2. Presence bus: audio-rate and animation-rate signals.
3. Live runtime: provider transport, microphone, playback, safety control, and lifecycle.

Those paths must not be collapsed into one state container.

## Feature Boundaries

### `voice/session`

Owns session-facing helpers:

- opener context
- caption merging
- continuation context
- session labels

Entry point: `frontend/src/voice/session/index.ts`.

### `voice/runtime`

Owns the active call runtime:

- `LiveVoiceSession`
- `callMachine`
- lifecycle timers
- transport, microphone, playback, and control ports
- reconnect and provider rotation behavior

Entry point: `frontend/src/voice/runtime/index.ts`.

`LiveVoiceSession` is the runtime owner. It does not render UI and does not own React state.

### `voice/safety`

Owns safety UX and interpretation:

- crisis copy and resources
- crisis enforcement
- lexical helpers
- risk rating

Entry point: `frontend/src/voice/safety/index.ts`.

The server remains the safety policy authority. Frontend safety code handles immediate user experience, muting, pause behavior, resource handoff, and control-plane retries.

### `voice/diagnostics`

Owns the bounded client flight recorder:

- `VoiceTrace`
- trace findings
- trace analysis
- browser download
- recursive redaction before upload

Entry point: `frontend/src/voice/diagnostics/index.ts`.

Raw local traces may contain caller-visible text for local debugging. Uploaded traces go through `redactTraceReport()` and the server repeats redaction defensively.

### `voice/ui`

Owns voice-facing presentation components:

- `VoiceOverlay`
- `VoiceTranscript`
- `LivePresence`

Entry point: `frontend/src/voice/ui/index.ts`.

The UI subscribes to individual Zustand selectors to avoid rendering the entire overlay for unrelated state changes.

### `voice/api`

Owns the feature API boundary:

- token minting
- control-plane event submission
- recall and reaction requests
- recap persistence
- usage reads
- trace upload
- error classification

Entry point: `frontend/src/voice/api.ts`, implemented by `services/api/voice.ts`.

Authentication, token refresh, timeout handling, and structured API errors remain in the shared HTTP layer.

### `voice/store`

Owns only discrete UI state:

- active/muted/capturing flags
- UI status and status detail
- floor state
- bounded turns
- captions
- crisis handoff copy
- quota display
- face commands

Entry point: `frontend/src/voice/store.ts`, implemented by `store/voice.ts`.

### `voice/presenceBus`

Owns high-frequency mutable signals:

- microphone energy
- playback energy
- prosody
- affect
- backchannel
- distress
- reaction

`LivePresence` samples this bus on animation frames. Audio frames do not trigger Zustand writes or whole-tree React renders.

## Runtime Flow

```text
VoiceOverlay
    |
    +-- creates LiveVoiceSession
    +-- subscribes to discrete useVoiceStore selectors
    +-- publishes presence signals
    +-- handles crisis handoff and recap

LiveVoiceSession
    |
    +-- voiceApi.mintVoiceSession()
    +-- audio ports
    +-- Gemini transport
    +-- SafetyBridge -> voiceApi.recordVoiceSessionEvent()
    +-- VoiceTrace
    +-- onTrace -> redactTraceReport -> voiceApi.submitDiagnostics()

VoiceTrace upload
    |
    +-- POST /api/voice/trace
    +-- authenticated owner check
    +-- server request-ID correlation
    +-- internal support review later
```

## Error State Mapping

`classifyVoiceError()` converts structured API failures into operational UI states:

| Backend condition | Frontend behavior |
| --- | --- |
| quota exhausted | unavailable state plus warning message |
| unauthenticated | sign-in guidance |
| conflict | active-session recovery path |
| unavailable/provider failure | error/unavailable plus dictation fallback |
| invalid payload | actionable error detail |

The runtime reports status through callbacks. The overlay decides how the message is rendered.

## Data Ownership

| Concern | Owner |
| --- | --- |
| Call phase transition | `callMachine` |
| Microphone and playback | runtime ports |
| High-rate visual signals | `presenceBus` |
| Stable UI state | Zustand voice store |
| Server policy and quota | backend voice domain |
| Crisis server decision | backend safety classifier/session service |
| Local diagnostics | `VoiceTrace` |
| Uploaded diagnostics | backend support diagnostics store |

## Extension Rules

When adding a new voice feature:

1. Put user-visible durable state in the voice store only if it changes at UI cadence.
2. Put capture-rate or animation-rate values on `presenceBus`.
3. Put provider or socket behavior in `voice/runtime`.
4. Put crisis policy and copy in `voice/safety`.
5. Put transport calls behind `voice/api`.
6. Put support instrumentation in `voice/diagnostics`.
7. Keep UI components in `voice/ui` and avoid making them runtime owners.

## Verification

The frontend is verified by the production bundle build:

```text
npm run build:app
```

The backend contract test verifies that owner trace upload and internal diagnostics operations are present in the OpenAPI route set.
