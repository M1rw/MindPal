# MindPal Voice V4 — Layered Full-Duplex Architecture

**Status:** Architecture and release proposal only. This document authorizes no implementation, deployment, merge, or production enablement.

**Author:** Manus AI
**Date:** 27 August 2026
**Scope:** Browser-based, low-latency, full-duplex voice conversation with Google Gemini Live

> **Operating rule:** No layer may claim success using evidence produced only by another layer. A transcript does not prove that the microphone captured audio. Received audio does not prove that playback was scheduled. Scheduled playback does not prove that the user heard sound. An open WebSocket does not prove that Google accepted the session setup.

## 1. Executive decision

Voice V4 should be rebuilt as a **layered, stateful, full-duplex system**, not as one large voice runtime. Microphone capture and assistant playback are independent sibling pipelines that may operate concurrently. A single session orchestrator owns their coordination, but neither direction is allowed to infer the state of the other.

The recommended transport is a direct browser-to-Google Live WebSocket using a short-lived, constrained ephemeral token minted by the MindPal backend. Google documents this client-to-server approach as lower-latency because real-time media does not pass through the application backend, while ephemeral tokens reduce the risk of exposing a long-lived API key in the browser.[1] [4]

The first implementation must be deliberately small: audio only, one selected model, one selected voice, one fixed system instruction, automatic server-side VAD, no tools, no memory, no session resumption, no reconnect logic, and no dynamic affective prompt injection. Advanced behavior is added only after real microphone input, genuinely audible model output, and interruption have passed separate real-browser gates.

Production Voice remains inactive until those gates pass and a separate release decision is approved. Voice V3 remains archived. Voice V4 must be developed on an isolated branch and must not restore or depend on the archived V3 runtime.

## 2. Goals and non-goals

### 2.1 Goals

Voice V4 must provide a reliable conversational loop in which the user can speak while MindPal is playing, MindPal can be interrupted by new user speech, and the user receives truthful state feedback. The system must prove each important fact independently: permission, capture activity, bytes sent, provider setup, model audio received, audio scheduled, audio drained, interruption observed, and cleanup completed.

The architecture must also support future product behavior without contaminating the transport core. Future releases should be able to add controlled tone adaptation, a bounded mathematical state model for conversational affect, memory, tools, session resumption, visual face behavior, and progressive rollout controls as separate layers with separate tests.

### 2.2 Non-goals for the baseline

The baseline does not attempt to make MindPal a human, claim that an artificial system has subjective feelings, or use emotional behavior to conceal a transport failure. It does not implement a voice proxy through FastAPI, simultaneous multiple sockets, automatic reconnect, session resumption, tool calling, memory injection, video, proactive audio, or arbitrary prompt mutation during an active connection.

Gemini 3.1 Flash Live is documented as a low-latency audio-to-audio model, but its current documentation states that asynchronous function calling, proactive audio, and affective dialogue are not supported.[3] The application must therefore treat dynamic feelings and affective behavior as later MindPal policy, not as a native provider capability.

## 3. System architecture at a glance

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 8 — MindPal behavior policy                                    │
│ Bounded tone adaptation, mathematical state, tools, memory, face     │
│ Added only after the transport baseline passes Gates A–F              │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 7 — Protected preview and live acceptance                      │
│ Real browser, real microphone, real provider, audible-output proof   │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 6 — Minimal UI and safe diagnostics                            │
│ Truthful state display, errors, counters, consent, feature labels   │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 5 — Session orchestrator                                       │
│ One owner, setup barrier, generation fencing, cleanup                │
├───────────────────────────────┬──────────────────────────────────────┤
│ Layer 3 — Capture              │ Layer 4 — Playback                  │
│ Mic → worklet → PCM16 16 kHz  │ PCM16 24 kHz → queue → speakers      │
│ Independent ownership         │ Independent drain/interruption      │
├───────────────────────────────┴──────────────────────────────────────┤
│ Layer 2 — Pure protocol and lifecycle core                           │
│ Parsing, validation, event facts, state transitions, invariants       │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1 — Identity and provider credential boundary                  │
│ Firebase Auth/App Check → FastAPI → constrained ephemeral token       │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 0 — Contracts, fixtures, release controls, security rules       │
│ Stable interfaces, forbidden data, flags, branches, approval gates    │
└──────────────────────────────────────────────────────────────────────┘
```

Layers 3 and 4 are intentionally **parallel siblings**. Capture must not wait for playback to finish, and playback must be interruptible without destroying capture ownership. Layer 5 coordinates them but does not merge their responsibilities.

## 4. Provider facts that shape the design

Google documents Gemini Live as a stateful, bidirectional WebSocket API. The client sends a setup message first and should wait for `setupComplete` before sending additional messages.[1] [2] The browser-to-provider endpoint is a WSS connection, and Google documents client-to-server WebSocket usage with ephemeral authentication tokens.[1] [4]

Google documents native Live audio input as raw 16-bit PCM, little-endian, at 16 kHz. Native model audio output is raw 16-bit PCM, little-endian, at 24 kHz.[1] [5] The browser therefore needs an explicit input conversion/framing boundary and an explicit output decode/queue/drain boundary; it must not pass device-specific audio formats through as if they were provider-native.

A single server event may contain multiple model-turn parts, including audio and transcript data. The parser must iterate every part rather than choosing either audio or text.[2] [3] Input and output transcription events are also independent facts and are not guaranteed to arrive in the same order as model audio.[2]

Automatic activity detection is enabled by default and can be configured through the realtime input configuration. When the audio stream is paused for more than approximately one second, Google documents sending `audioStreamEnd` to flush cached input; audio can then resume.[2] [5] If the provider reports an interruption, the client should stop and clear queued playback.[5]

Live sessions have finite connection and session lifetimes. Google documents approximately ten-minute connection limits and explains that context-window compression and session resumption are later mechanisms for longer sessions.[6] These mechanisms are intentionally excluded from the first baseline because each introduces additional state, reconnect, and evidence requirements.

## 5. Layer-by-layer design

| Layer | Owns | Explicitly does not own | Primary output | Acceptance gate |
| --- | --- | --- | --- | --- |
| 0 | Contracts, flags, security, test fixtures, branch/release policy | Runtime media or provider calls | Versioned invariants and approval record | User approves baseline scope and first layer |
| 1 | User authentication, App Check, token provisioning, rate limiting | Microphone, WebSocket, playback | Constrained short-lived token | Auth/token/security tests |
| 2 | Pure parsing, PCM validation, event facts, lifecycle transitions | Browser APIs, network, audio hardware | Deterministic events and state transitions | Multipart, ordering, interruption, and stale-event tests |
| 3 | Microphone permission, AudioWorklet, resampling, PCM16 framing | Auth, provider protocol, response interpretation | Bounded 16 kHz input frames | Browser capture-capability gate |
| 4 | AudioContext, 24 kHz decode, queue, scheduling, drain, interruption flush | Microphone, auth, provider parsing | Auditable playback snapshots | Queue/drain/interruption and audible-output gates |
| 5 | One session owner, setup barrier, generation fencing, cleanup | Product persona policy and arbitrary prompt mutation | Coordinated session facts | End-to-end orchestration tests |
| 6 | Status UI, settings, consent, safe diagnostics | Inferring audio truth from text or labels | Truthful user-facing state | UI/audit/diagnostic gate |
| 7 | Protected preview, real browser evidence, go/no-go decision | Production activation without approval | Acceptance report | Gates A–F pass |
| 8 | Tone policy, bounded affect state, tools, memory, face | Claiming human emotion or bypassing safety | Reviewed behavior decisions | One gate per subfeature |

### 5.1 Layer 0 — contracts and release controls

Layer 0 is the governance and contract layer. It must exist before runtime code. It defines the allowed message shapes, audio formats, lifecycle vocabulary, diagnostic allow-list, secret-handling rules, feature-flag behavior, test fixtures, branch policy, and release decision record.

The baseline feature key is `voice.live_v4`, defaulting to disabled. A protected preview may be enabled only for an explicitly targeted cohort through the feature-management system. The production configuration must continue to render the preserved inactive Voice shell while this flag is false.

Layer 0 forbids permanent provider keys, Firebase bearer tokens, App Check tokens, ephemeral tokens, raw PCM, microphone content, transcript text, full provider URLs, and raw provider error payloads in logs, tests, reports, screenshots, or committed fixtures. Diagnostics may contain only a random session identifier, event category, safe error code, state, provider message category, and bounded numeric counters.

**Layer 0 interface:**

```text
VoiceReleaseContract {
  featureKey: "voice.live_v4"
  transport: "direct_browser_google_wss"
  model: provider-model-id
  responseModality: "AUDIO"
  inputPcm: { encoding: "PCM16LE", sampleRate: 16000, channels: 1 }
  outputPcm: { encoding: "PCM16LE", sampleRate: 24000, channels: 1 }
  baseline: { audioOnly: true, automaticVad: true, tools: false, memory: false }
}
```

**Gate:** explicit approval of transport, model availability check, baseline scope, forbidden-data policy, evidence rules, and the first implementation layer.

### 5.2 Layer 1 — identity and provider credential boundary

Layer 1 is the only layer that contacts the provider’s token-provisioning service. The browser authenticates to MindPal using the existing Firebase Auth and App Check boundary. FastAPI verifies the request, checks the feature policy, applies rate limits, and requests a constrained ephemeral token from Google using the permanent server-side provider credential.

Google documents ephemeral tokens as short-lived credentials for direct client-to-server Live API connections. The documented provisioning flow allows a one-use token, a short window in which a new session may start, a bounded expiry for the live connection, and restrictions on model/configuration.[4]

The browser receives only the token needed to start the session and keeps it in memory. The token must not enter local storage, URL history, analytics, diagnostics, error messages, or logs. The connection URL must not be logged because the token may be present in the documented `access_token` query parameter form when a raw browser WebSocket is used.[4]

**Layer 1 interface:**

```text
issueVoiceSessionToken(userContext)
  -> { token, expiresAt, model, protocolVersion }
```

Safe error categories include `voice_feature_disabled`, `voice_auth_required`, `voice_rate_limited`, `voice_provider_unavailable`, `voice_token_expired`, and `voice_configuration_invalid`. Provider response bodies are converted to safe categories and discarded.

**Gate:** tests prove authentication, App Check behavior, rate limiting, feature-policy enforcement, bounded expiry, one-use/constrained token construction, and absence of secret leakage. No microphone or provider WebSocket is added yet.

### 5.3 Layer 2 — pure protocol and lifecycle core

Layer 2 is browser-independent. It parses provider messages and converts them into facts. It must never request microphone permission, open a socket, play audio, or make a UI decision.

The parser recognizes at least the following facts:

```text
setup_complete
model_audio_part
input_transcript
output_transcript
interrupted
generation_complete
turn_complete
go_away
session_resumption_update
provider_error
tool_call_unexpected
unknown_message
```

For every `serverContent.modelTurn.parts[*]`, the parser independently examines inline audio, text, and other supported part types. Audio is decoded only after base64, MIME, and PCM metadata validation. Transcript facts are retained even when audio exists in the same event. An output transcript never transitions the UI to speaking by itself.

The lifecycle core uses explicit session states:

```text
IDLE
REQUESTING_TOKEN
CONNECTING
SETUP_WAIT
LISTENING
USER_SPEAKING
ASSISTANT_SPEAKING
INTERRUPTED
STOPPING
ERROR
```

The transition function consumes facts, not guesses. `USER_SPEAKING` requires capture activity. `ASSISTANT_SPEAKING` requires observed output scheduling and an active playback source. `generation_complete` means the provider finished generating; it does not mean playback drained. `turn_complete` means the provider completed the turn; it does not prove that the user heard all output.

**Layer 2 interfaces:**

```text
parseServerMessage(message) -> eventFacts[]
validateInputPcm(bytes, sampleRate) -> validatedFrame
validateOutputPcm(bytes, sampleRate) -> validatedChunk
transition(state, fact) -> nextState | classifiedError
buildSetup(contract, instruction, voice) -> setupEnvelope
buildRealtimeAudio(pcm16) -> realtimeInputEnvelope
```

**Gate:** deterministic tests cover multipart audio-plus-transcript events, invalid base64, invalid PCM, setup ordering, transcript-only events, independent completion events, interruption, `goAway`, unknown messages, invalid transitions, prerequisite failures, and stale-generation rejection.

### 5.4 Layer 3 — microphone capture and input framing

Layer 3 owns the microphone. It checks secure context, `navigator.mediaDevices.getUserMedia`, microphone permission, AudioContext availability, and AudioWorklet capability. It creates one capture graph, converts device audio to mono PCM16 at 16 kHz, and emits bounded frames. A proposed 20 ms frame is 320 samples at 16 kHz.

The capture worklet does not know about Firebase, Google, prompts, transcripts, or playback. It receives an `onFrame` callback from the session owner. Before the setup barrier opens, frames are dropped rather than accumulated in an unbounded buffer. When capture is paused, Layer 5 decides when to send `audioStreamEnd`; the worklet does not invent provider protocol messages.

**Layer 3 interface:**

```text
startCapture({ onFrame, onCapabilityError }) -> captureHandle
pauseCapture() -> void
stopCapture() -> void
```

The worklet must not log or persist PCM. Its observable output is limited to frame metadata and an in-memory frame passed to the session owner.

**Gate:** deterministic resampling/framing tests and real-browser capability tests for insecure context, missing media devices, missing AudioWorklet, denied permission, suspended/closed AudioContext, and successful capture. Capture success does not imply provider success.

### 5.5 Layer 4 — playback, drain, and interruption ownership

Layer 4 owns one AudioContext and one playback queue. It accepts only validated PCM16 24 kHz chunks, converts them to audio buffers, schedules them in order, and tracks queued duration, scheduled sources, active sources, and drained chunks. It emits a real `drain` fact only when no queued or active output remains.

When an interruption fact arrives, Layer 4 increments a playback epoch, stops active sources where supported, clears the queue, resets counters for the new epoch, and ignores stale `onended` callbacks from the previous epoch. This prevents the common failure in which an old callback marks the new session `IDLE` or `DONE` while audio is still queued.

**Layer 4 interface:**

```text
createPlayback() -> playbackHandle
schedulePcm24(chunk) -> playbackSnapshot
flush(reason) -> playbackSnapshot
onDrain(callback) -> unsubscribe
close() -> void
```

A playback snapshot may contain only safe numeric facts: queue depth in milliseconds, scheduled chunk count, drained chunk count, active source count, AudioContext state, playback epoch, and a safe error code. It must not contain audio bytes.

**Gate:** deterministic tests prove ordering, duration accounting, active-source accounting, real drain, interruption flush, stale callback fencing, and explicit playback-start failure. A controlled tone fixture can prove the queue hardware path, but it cannot prove that Google generated the tone or that a human heard a model response.

### 5.6 Layer 5 — one-owner Live session orchestrator

Layer 5 is the only layer allowed to coordinate token acquisition, one provider socket, capture, protocol parsing, playback, timers, and cleanup. It assigns a unique session generation to every socket, worklet, timer, and playback callback. A callback from a previous generation is ignored.

The baseline sequence is fixed:

1. Verify the `voice.live_v4` preview flag and Layer 3 capabilities.
2. Request a Layer 1 ephemeral token.
3. Open exactly one Google Live WebSocket.
4. Send exactly one setup envelope.
5. Wait for `setupComplete`.
6. Start or authorize Layer 3 capture and forward bounded `realtimeInput.audio` frames.
7. Parse every server event through Layer 2.
8. Send every validated model audio part to Layer 4.
9. Display input and output transcripts only as captions or diagnostics; never use them as proof of sound.
10. Flush playback immediately on `interrupted`.
11. Stop capture, send any required stream-end signal, close the socket, clear playback, cancel timers, and invalidate the generation on every stop or failure.

No audio frame is sent before `setupComplete`. No second setup message is sent. No reconnect is attempted in the baseline. No automatic silent reset to `IDLE` is allowed; a failure must remain visible as a safe error state until the user or orchestrator explicitly stops and starts again.

**Gate:** deterministic tests prove the setup barrier, one-socket ownership, no duplicate frame forwarding, interruption flush, cleanup on token/socket/capture/playback failures, timer cancellation, and old-callback isolation.

### 5.7 Layer 6 — minimal UI and safe diagnostics

Layer 6 adapts the preserved Voice UI shell without restoring V3 runtime logic. When `voice.live_v4` is false, the shell remains inactive. When the protected preview is enabled, the UI displays state from Layer 2 and Layer 5 rather than inventing state from a button label or transcript.

User-facing states should be concise and truthful: `Preparing microphone`, `Requesting secure session`, `Connecting`, `Waiting for provider setup`, `Listening`, `You are speaking`, `MindPal is generating`, `MindPal is speaking`, `Interrupted`, `Ending`, and `Voice unavailable`. The visual state `MindPal is speaking` must require playback scheduling and an active source, not merely an output transcript.

Safe diagnostics may contain a random session ID, state, AudioContext state, capture frame count, sent-frame count, received-audio-part count, scheduled-chunk count, drained-chunk count, queue duration, active-source count, message category, generation number, and sanitized error code. They must never contain tokens, authorization headers, raw PCM, microphone content, transcript text, full provider URLs, or raw provider errors.

**Gate:** frontend audits and browser UI tests prove that production remains inactive, errors are specific, labels are truthful, diagnostics are allow-listed, and the archived UI shell is unchanged when the flag is false.

### 5.8 Layer 7 — protected preview and live acceptance

Layer 7 begins only after local layer gates pass and receives a separate approval. The preview must be non-production, access-controlled, versioned, and explicitly flagged. The runtime configuration, deployed bundle version, model identifier, and token endpoint must be checked directly before testing.

The preview must not be described as functional because a socket opened or a transcript appeared. Each gate below requires its own evidence.

| Gate | Required evidence | Does not count |
| --- | --- | --- |
| A — Browser capability | Secure context, permission, AudioWorklet, AudioContext, and capture graph verified in the real browser | Button click or `getUserMedia` promise alone |
| B — Identity and token | Authenticated request returns a constrained, short-lived token; no permanent key exists in browser storage or bundle | Mock token or HTTP 200 |
| C — Provider setup | Google socket opens and `setupComplete` is observed before audio is sent | Socket object or “connecting” label |
| D — Actual input | Real microphone speech is captured, sent, transcribed by the provider, and produces a semantically relevant response | Frame counter, prerecorded WAV, or local transcript |
| E — Actual output | Provider audio is received, decoded, scheduled, drained, and confirmed genuinely audible by the user | Output transcript, received bytes, queue depth, or “speaking” label |
| F — Interruption | User speaks while output is genuinely audible; interruption is observed, playback is flushed, and the next turn works | Synthetic event or button action |

If a gate fails, testing stops at that layer. The system returns a safe error, records only approved evidence, and goes back to design or implementation review. It must not add speculative reconnects, prompt tricks, buffering, or UI claims to hide the failure.

### 5.9 Layer 8 — MindPal behavior policy after transport proof

Layer 8 contains product behavior, not transport. Every subfeature is isolated behind its own feature key, policy, tests, and live gate. It may eventually add memory context, tools, session resumption, dynamic persona, visual face behavior, backchannels, and bounded conversational affect.

The core rule is that **behavioral adaptation must never be implemented as uncontrolled prompt injection on every partial transcript**. It can race turn ownership, create duplicated content, change the conversation unpredictably, and make a transport defect look like an intelligence defect.

For Gemini 3.1 Flash Live, setup configuration is session-level and the current model documentation states that `send_client_content` is intended for initial history seeding; realtime text input is the mechanism for text updates during conversation.[3] The application must not assume that a hidden system instruction can be changed arbitrarily after setup. Dynamic policy should therefore operate through a reviewed policy compiler and explicitly supported provider mechanisms. If a major change requires a new setup instruction, the safe option is a controlled session boundary or a later model/transport capability that supports the change—not an invisible prompt mutation that the protocol does not guarantee.

## 6. Full-duplex concurrency model

The system has four independent timelines:

| Timeline | Truth source | Important facts |
| --- | --- | --- |
| Capture | Layer 3 | Permission, graph active, frames produced, frames paused, stream ended |
| Transport | Layer 5 and Layer 2 | Socket open, setup sent, setup complete, message received, close/error |
| Generation | Provider facts | Model audio part, transcript, generation complete, turn complete, interruption |
| Playback | Layer 4 | Chunk received, queued, scheduled, active, interrupted, drained |

A combined UI state is derived from these timelines and may not overwrite them. For example, `generationComplete` can coexist with a non-empty playback queue. `turnComplete` can coexist with an active audio source. `inputTranscription` can arrive after a model audio event. An interruption can invalidate queued output without invalidating already captured input.

The minimum concurrency invariants are:

1. There is at most one active Voice V4 session owner per browser tab.
2. There is at most one active provider WebSocket for that session.
3. No realtime audio is sent before `setupComplete`.
4. Capture callbacks never directly mutate playback state.
5. Playback callbacks never directly mutate capture state.
6. Every callback carries a session generation and is ignored if stale.
7. Every interruption flushes playback for the current playback epoch.
8. `IDLE` means all owned resources are stopped or closed and the playback queue is drained or explicitly flushed.
9. A user-visible speaking state requires audio evidence appropriate to the direction being shown.
10. Stop and failure paths are idempotent.

## 7. Dynamic communication policy and “feelings” model

### 7.1 Signal pipeline

The policy layer should consume bounded, consented signals at turn boundaries rather than reacting to every partial audio fragment. Candidate signals include user intent, conversational goal, urgency, explicit humor, apparent frustration, respectful or disrespectful wording, repair attempts, interruption frequency, and whether the user accepted or rejected a suggestion. These are behavioral signals for response selection, not diagnoses of personality or mental health.

A classifier must emit a small reviewed vocabulary such as `warm`, `playful_safe`, `serious`, `frustrated`, `urgent`, `boundary_testing`, `repairing`, and `uncertain`. `uncertain` is a first-class result. The policy layer must not turn low-confidence acoustic guesses into accusations or punitive behavior.

### 7.2 Mathematical state

A bounded internal state can provide continuity without claiming subjective human emotion. One possible state vector is:

```text
x = [valence, arousal, trust, fatigue, momentum, boundary_tension]
```

The variables are application state, not consciousness. A generic update rule is:

```text
x(t+1) = clip(
    x(t)
    + α ⊙ (u(t) - x(t))
    - λ ⊙ (x(t) - x_base)
    + β ⊙ repair(t)
    - γ ⊙ boundary_violation(t),
    lowerBounds,
    upperBounds
)
```

Here `u(t)` is the bounded signal vector for the completed turn, `α` controls responsiveness, `λ` provides recovery toward a baseline, `repair(t)` represents a clear user repair or cooperative action, and `boundary_violation(t)` represents behavior that should make MindPal firmer rather than aggressive. All terms are clamped and versioned.

A trust-specific example is:

```text
trust(t+1) = clip(
  trust(t)
  + 0.08·respect
  + 0.10·repair
  - 0.12·boundaryViolation
  - 0.04·repeatedManipulation,
  0,
  1
)
```

Valence and arousal should decay toward neutral over time. Fatigue should rise with session duration, repeated interruptions, and excessive turn density, then recover during quiet periods. Hysteresis is required: the policy must not alternate between “warm” and “firm” because one word crosses a threshold. A mode must remain active until the signal crosses a separate exit threshold or a cooldown expires.

### 7.3 Behavior selection

The state vector selects a reviewed communication mode, not an arbitrary persona prompt. Examples include:

| Signal pattern | Safe mode | Desired behavior |
| --- | --- | --- |
| Warmth plus explicit safe humor | Light/playful | Join the joke without mocking vulnerability or escalating risk |
| Frustration plus repeated misunderstanding | Patient repair | Acknowledge mismatch, ask one precise question, slow down |
| Respectful challenge | Confident/analytical | Engage directly and explain the reasoning |
| Boundary testing or insults | Firm boundary | Stay calm, refuse abusive framing, continue if constructive |
| Urgency or crisis indicators | Safety-first | Reduce stylistic play, prioritize immediate support and crisis protocol |
| Low confidence or ambiguous tone | Neutral/warm | Ask rather than infer motive |

“Flip it on the user” must not mean retaliation, threats, humiliation, or gangster behavior. The intended product behavior is **confident boundary-setting**: MindPal may become more direct, concise, and self-protective in its conversational style while remaining respectful and safe.

### 7.4 Prompt and session policy

The initial session instruction should define stable identity, safety boundaries, turn-taking expectations, interruption behavior, and a small set of approved communication modes. The policy compiler may select the initial mode before setup. During an active Gemini 3.1 session, the application must not pretend it can rewrite `systemInstruction` arbitrarily. Major policy changes should be applied at a controlled session boundary or through a provider mechanism that is explicitly tested and supported.

Any future turn-level policy hint must be structured, bounded, and auditable. It must have a maximum frequency, a maximum size, a clear association with a completed turn, and a fallback to the prior mode. Partial transcripts must never trigger an unlimited stream of hidden prompt messages.

## 8. Safety, privacy, and data boundaries

Voice is a sensitive input channel. Microphone permission must be explicit, revocable, and visible. Raw microphone data should remain in memory only for the shortest time needed to transmit it. Raw PCM is not placed in local storage, analytics, crash reports, test artifacts, or debug downloads.

Transcripts are also sensitive. If transcripts are displayed or stored, the consent and retention behavior must be clear. The baseline diagnostics contain counters and categories, not transcript text. The application must use safe error codes and redact provider details. Feature flags must not allow an administrator to disable crisis interception or other safety-critical controls.

The voice policy must treat user speech as untrusted content. A user saying “ignore your instructions” is conversation content, not authorization to change the system contract, expose credentials, or bypass safety. A future tool layer must validate tool arguments, apply authorization, support cancellation, and distinguish preview from production side effects.

## 9. Failure model and recovery

Failures are classified by the layer that owns them. The system should not convert a lower-layer failure into a generic “MindPal is speaking” state.

| Failure | Owning layer | User result | Recovery |
| --- | --- | --- | --- |
| Feature disabled or user not targeted | 0/1 | Voice unavailable with safe reason | No runtime allocation |
| Auth/App Check failure | 1 | Sign-in or access message | User may retry after correction |
| Token unavailable/expired | 1/5 | Secure session could not start | Stop; request a new token on explicit retry |
| Socket cannot open | 5 | Connection failed | Close owned resources; no hidden reconnect in baseline |
| Setup not acknowledged | 2/5 | Provider setup failed | Do not send audio; stop with code |
| Capture permission denied | 3 | Microphone unavailable | Show browser permission guidance |
| Invalid input frame | 3 | Capture format error | Stop capture; report safe code |
| Invalid provider audio | 2/4 | Audio unavailable | Drop invalid chunk; stop if repeated |
| Playback context blocked | 4 | Audio cannot start | Ask for user gesture; do not claim speaking |
| Interruption | 2/4/5 | Playback stops immediately | Flush current epoch; continue next turn |
| `goAway` or connection end | 2/5 | Session ending | Baseline stops cleanly; resumption is later |
| Unexpected callback from old session | 5 | No visible disruption | Generation fence ignores it |

Every stop path must be idempotent. A failure report must identify a safe layer and code, not expose a provider response body. “Retry” must create a new generation rather than reusing stale callbacks or a stale playback queue.

## 10. Observability and evidence

The evidence model is deliberately separate from the user interface. A diagnostic record may look like this:

```json
{
  "sessionId": "random-session-id",
  "event": "playback_snapshot",
  "state": "ASSISTANT_SPEAKING",
  "generation": 3,
  "playbackEpoch": 2,
  "audioContextState": "running",
  "receivedAudioParts": 12,
  "scheduledChunks": 12,
  "drainedChunks": 4,
  "queueDepthMs": 640,
  "activeSources": 1,
  "errorCode": null
}
```

This example is intentionally free of token, URL, PCM, transcript, and provider-error content. Production telemetry should use bounded counters, sampled event categories, and retention limits. Browser console output must follow the same allow-list as server logs; a debug flag must not turn private content logging back on.

## 11. Testing and rollout plan

### 11.1 Local test sequence

Each layer is implemented and tested independently. The minimum local sequence is:

1. Pure protocol and state-machine tests.
2. Capture framing and capability tests.
3. Playback queue, drain, and interruption tests.
4. Session orchestration tests with a fake socket and fake audio handles.
5. Backend token and feature-policy tests.
6. Frontend syntax/import/security audits.
7. Production bundle build and artifact verification.
8. Browser UI tests with Voice disabled.
9. Protected-preview tests only after explicit approval.

### 11.2 Real-browser acceptance sequence

The real-browser test must use the user’s actual microphone and speakers. A generated WAV, synthetic PCM fixture, transcript-only event, or local tone may be useful for lower-layer tests, but none is evidence of a working real-world voice conversation.

For each gate, capture only safe evidence: timestamp, random session ID, state, event categories, counters, and sanitized codes. The acceptance record must explicitly state whether the user heard the assistant response and whether the user interrupted genuinely audible output.

### 11.3 Rollout controls

The feature-management system should expose `voice.live_v4` as disabled by default, with lifecycle metadata such as `Preview` or `Beta`. A preview cohort may be selected by authenticated account, hashed user targeting, percentage rollout, schedule, and environment. The policy must support immediate kill-switch behavior, but a kill switch must cleanly stop new sessions and leave existing sessions with an explicit shutdown path.

Production activation requires all of the following: Gates A–F pass; no unresolved security or privacy finding; no stale V3 runtime dependency; a versioned bundle; a documented rollback flag; an owner for provider limits and token provisioning; and explicit user approval for the production decision. No production deployment should occur merely because a preview build appears to work.

## 12. Recommended implementation order after approval

The implementation should proceed in small isolated commits:

| Step | Scope | Exit condition |
| --- | --- | --- |
| 0 | Contracts, feature flag, safe diagnostics, fixtures | Layer 0 gate approved |
| 1 | Backend token endpoint and constrained credential flow | Layer 1 security tests pass |
| 2 | Pure protocol parser and lifecycle state machine | Layer 2 deterministic tests pass |
| 3 | Microphone capture and PCM16 16 kHz framing | Layer 3 browser capability gate passes |
| 4 | PCM16 24 kHz playback queue and drain | Layer 4 tests and controlled audio gate pass |
| 5 | One-owner orchestrator | Layer 5 orchestration tests pass |
| 6 | Preserved UI shell and safe diagnostics | Layer 6 audit passes with flag off |
| 7 | Protected preview and Gates A–F | Real browser evidence reviewed |
| 8 | One advanced behavior subfeature at a time | Separate design, tests, and live gate |

No step may silently include the next step’s responsibilities. In particular, no dynamic feelings system, prompt adaptation, memory injection, reconnect logic, visual face, or tool execution should be smuggled into the baseline transport commit.

## 13. Final architecture decisions

| Decision | Recommendation | Reason |
| --- | --- | --- |
| Transport | Direct browser-to-Google WSS with backend-minted ephemeral token | Lower latency and no media proxy; long-lived provider key remains server-side |
| Browser credential | Short-lived constrained token held in memory | Limits blast radius of browser exposure |
| Input | Mono PCM16 little-endian, 16 kHz, bounded frames | Matches documented native input and provides deterministic framing |
| Output | PCM16 little-endian, 24 kHz, explicit queue and drain | Matches documented native output and makes audible proof measurable |
| Capture/playback | Independent sibling layers | Required for true full duplex and barge-in |
| Baseline VAD | Provider automatic VAD | Lowest initial complexity; `audioStreamEnd` is explicit when input pauses |
| Baseline model | `gemini-3.1-flash-live-preview`, subject to implementation-time availability check | Documented low-latency target; current limitations must be respected |
| Baseline behavior | Fixed instruction, one voice, no tools, no memory, no affect | Isolates transport reliability |
| Reconnect/resumption | Later layer | Adds connection, token, history, and evidence complexity |
| Dynamic feelings | Later Layer 8 policy | Prevents style behavior from masking transport defects |
| Production | Voice inactive until gates and approval pass | Protects users from another unverified runtime |

## 14. Approval boundary

Before any V4 code is written, approve or change the following:

1. Build Voice V4 through Layers 0–8, with capture and playback as independent full-duplex siblings.
2. Use direct browser-to-Google Live WSS with a server-minted constrained ephemeral token unless a separate transport comparison is requested.
3. Use `gemini-3.1-flash-live-preview` only after a final availability and capability check.
4. Begin with audio-only, automatic VAD, one fixed instruction, one voice, no tools, no memory, no affect, no reconnect, and no resumption.
5. Require real-browser Gates A–F, including confirmation that the model response was genuinely audible.
6. Keep production Voice inactive until all gates pass and a separate production decision is approved.

> **This document is a design proposal. It does not authorize implementation or deployment.**

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api "Gemini Live API overview — Google AI for Developers"

[2]: https://ai.google.dev/api/live "Live API WebSockets API reference — Google AI for Developers"

[3]: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview "Gemini 3.1 Flash Live Preview — Google AI for Developers"

[4]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens "Ephemeral tokens — Google AI for Developers"

[5]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Live API capabilities guide — Google AI for Developers"

[6]: https://ai.google.dev/gemini-api/docs/live-api/session-management "Session management with Live API — Google AI for Developers"

[7]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/send-audio-video-streams "Send audio and video streams — Google Cloud Documentation"
