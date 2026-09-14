# MindPal Voice End-to-End Audit — 2026-08-18

## Scope and evidence

This audit reviewed every module that participates in MindPal’s live Voice experience, from browser capture through provider setup and backend tools to on-screen captions. It was triggered by the observed production behavior: MindPal visually entered **Listening** while the user spoke but gave no audible acknowledgement, and visually entered **Thinking** during fact/tool work without reliably speaking a brief wait phrase.

> **Conclusion:** The central defect is architectural, not a single prompt defect. The current system has multiple independent state setters. Several of them update UI state, but none establishes a verifiable contract that a corresponding audible provider turn was accepted, started, or completed.

## Frontend inventory

| Module | Current responsibility | Audit result |
|---|---|---|
| `voice/constants.js` | Voice profile, audio thresholds, legacy timing values. | Stable prebuilt voice is defined as `Aoede`, but legacy silence/turn constants remain without a single owner. |
| `voice/conversation_policy.js` | Capture-quality, provider-VAD, current-fact, and busy-state policies. | Correctly treats provider VAD as semantic turn authority; however, it has no policy for **audible presence**. |
| `voice/pcm_capture_worklet.js` | Captures 2,048-sample microphone frames. | Transport-only; no semantic or acknowledgement behavior. |
| `voice/fact_verifier.js` | Authenticated backend current-fact request. | Returns verified/unverified results but does not describe whether a spoken bridge was heard. |
| `voice/prompts.js` | Live personality and response instruction. | Promises warm acknowledgements after provider yield, but explicitly instructs the model not to speak while the user is active. Prompts alone cannot generate real-time backchannels. |
| `voice/recovery_policy.js` | Bounded GoAway/transient/429 recovery. | Recovery budgets are separated and deterministic. This is not the source of conversational silence. |
| `voice/session_policy.js` | Thirty-minute product ceiling and inactivity handling. | Correctly separate from provider transport lifetime. |
| `voice/startup_helpers.mjs` | Token fetch, Retry-After parsing, WebSocket close classification. | Correctly avoids rate-limit retry storms; authentication remains a required live-test prerequisite. |
| `voice/tools.js` | Gemini function declarations and backend tool executor. | Declares `web_search` to the provider while the runtime also launches independent verified-fact work. This creates competing current-fact paths. |
| `voice/runtime.js` | Capture, provider WebSocket, playback, tools, fact verification, lifecycle, and recovery. | This is the main ownership problem; confirmed issues are listed below. |
| `voice_session.js` | Thin facade over the runtime. | Does not add logic; forwards the runtime’s behavior. |
| `voice_live.js` | Overlay, status labels, captions, persistence controls. | The five labels are a UI projection only. `Thinking…` can be rendered before or without any provider audio. |
| `voice_visualizer.js` | Renders microphone/model waveform. | Visual-only. It must never be treated as evidence that the model acknowledged the user. |

## Backend inventory

| Component | Current responsibility | Audit result |
|---|---|---|
| `api/voice_router.py` | Authenticated ephemeral token, verified fact, transcription, and post-call summary routes. | Token constrains a Gemini 3.1 Live audio session; verified fact accepts a soft-empty web result as a successful tool result, which needs stricter evidence semantics. |
| `api/tools_router.py` | Authenticated shared tool gateway. | Logical tool failures are returned inside a 200 response, so the runtime must inspect the body and speak an outcome rather than treating HTTP success as task success. |
| `tools/web_search_tool.py` | DuckDuckGo HTML/Instant/Lite search cascade. | Current-news quality is not guaranteed; zero results are a successful empty data response. It must not be presented as verified evidence. |
| `tools/voice_tools.py` | Post-call summary and standalone transcription. | Not part of the live audio loop; it cannot solve live backchannel or thinking behavior. |
| `api/dependencies.py` and `services/auth_service.py` | Firebase/App Check request context. | Correctly requires a valid signed-in Firebase session for Voice; the observed 401 was an unauthenticated browser state, not a Voice audio failure. |
| `core/config.py` | Live model and policy settings. | Production default is `gemini-3.1-flash-live-preview`; the active provider feature set does not support client-declared asynchronous function calls. |
| `api/tts_router.py` and `services/tts_service.py` | Separate text-to-speech service. | Not connected to the Gemini Live playback path. Browser TTS fallback cannot be used as a seamless Voice backchannel without a separate, explicitly designed voice-consistency policy. |

## Confirmed runtime failure chain

### 1. Long-speech “listener cue” is status-only

After approximately 2.4 seconds of confirmed capture, `runtime.js` sets `listenerCue: "I’m with you — keep going."` as an audio-state property. It does **not** send a provider request, create audio, or add a caption. The user therefore receives a visual Listening state but no audible acknowledgement.

### 2. The current prompt explicitly disables the requested behavior

The Voice prompt states that automatic VAD owns the speaking boundary and that MindPal must not speak while the user is actively talking. That policy is appropriate for a conservative half-duplex experience, but it cannot meet the requested full-duplex conversational-presence experience.

### 3. Thinking bridges are sent at a provider-blocked moment

`handleBlockingToolCalls()` marks `Thinking…`, calls `requestThinkingBridge()`, then immediately executes and answers the provider’s function call. On the active model, the provider is awaiting its blocking function response. The injected `realtimeInput.text` bridge is therefore not a reliable independent audio turn. A status change occurs; audible speech is not guaranteed.

### 4. Current facts have two competing search paths

For an utterance such as “Who is the mayor of New York?”, the runtime launches backend fact verification while the provider may also call declared `web_search`. The fact gate blocks speculative model audio, while the provider tool path may be blocking. This makes the intended bridge especially likely to be delayed, skipped, or reordered.

### 5. Tool work pauses microphone input

`sendPcmToWebSocket()` and `sendSilenceFrame()` return early while `_toolCallPending` is true. During a blocking provider tool call, the browser can stop sending user audio. This directly conflicts with the product requirement that MindPal continues listening while work is in progress.

### 6. UI state has no audio-delivery acknowledgement

The overlay derives **Thinking…** from runtime phase and background-task count. It has no `bridgeAccepted`, `bridgeAudioStarted`, or `bridgeTurnCompleted` input. Consequently, it can communicate activity that the user never hears.

### 7. Verification can be marked successful without usable evidence

The backend web-search tool returns an ordinary successful data shape for zero results. The verified-fact route currently treats any `result.ok` as `verified=True`, even if no usable current evidence exists. That must be changed to an explicit evidence-quality decision.

## Provider reality and truthful redesign boundary

The active `gemini-3.1-flash-live-preview` configuration supports streamed audio, automatic VAD, interruption, input/output transcription, function calling, session resumption, and context-window compression. The active implementation cannot rely on client-declared asynchronous functions or proactive audio to independently speak over a live user turn.

Accordingly, the rebuild must not fake full duplex through a UI label or silent `realtimeInput` instruction. The next implementation phase will do four things:

1. Make audible bridges a **sequenced provider turn** with explicit accepted/started/completed state, never a status-only property.
2. Remove competing provider `web_search` execution for current-fact questions; route those through one backend verified-evidence contract, including explicit empty-evidence failure.
3. Keep microphone transport open during all local/backend work so the user can interrupt or redirect without losing audio.
4. Make each visible Voice label derive from actual transport or playback evidence. In particular, **MindPal is speaking…** requires scheduled audio, and **Thinking…** requires a live task plus either a verified spoken bridge or an explicit provider-bound silent-work state that does not claim audible speech.

## Test gaps to close

The existing suites cover token security, retry budgets, status vocabulary, prompt content, and selected source contracts. They do not simulate the complete event ordering of: provider turn complete → bridge request → bridge audio → tool/fact completion → answer audio → user interruption. The rebuild must add deterministic event-fixture tests for this exact sequence, including tool body-level failures and empty verified-search evidence.

## References

[1] [Google Gemini Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
[2] [Google Gemini Live API tool use](https://ai.google.dev/gemini-api/docs/live-api/tools)
[3] [MindPal provider capability findings](./voice_provider_capability_findings_2026-08-18.md)

## Native-audio capability and production status

The original `gemini-3.1-flash-live-preview` configuration cannot use proactive audio, affective dialog, or asynchronous function calling. The official Live API capability comparison states that the Gemini 2.5 Flash Live native-audio model supports those features in a v1beta Live configuration, while Gemini 3.1 does not. MindPal selects the native model `gemini-2.5-flash-native-audio-preview-12-2025` and v1beta for its secure browser Voice transport. However, the constrained WebSocket used by that ephemeral-token transport is a distinct compatibility boundary.

The Gemini Developer API documentation explicitly lists both `gemini-2.5-flash-native-audio-preview-12-2025` and `gemini-3.1-flash-live-preview` as available on its free tier. The free tier therefore does not itself exclude native audio; capacity remains subject to project-specific rate limits. [4] [5]

On 2026-08-18, MindPal production telemetry captured a clean `1007` close before setup completed: `Invalid JSON payload received. Unknown name "proactivity" at 'setup': Cannot find field.` This proves that `setup.proactivity` cannot be sent on the constrained ephemeral-token endpoint currently used by MindPal, even though the SDK-oriented Live API documentation describes proactive audio. The free tier is not the cause. MindPal therefore omits `setup.proactivity` and does **not** claim spoken acknowledgements while the user is still talking on this transport. [6] [7]

The reliable native-audio baseline preserves the native Kore voice, v1beta transport, continuous microphone capture, VAD-driven barge-in, AI-only captions, lifecycle safety, verified fact routing, timezone context, and the conversation firewall. Provider functions remain disabled while the preview is tested, and changing public facts continue through MindPal’s authenticated verified-evidence route. No fake audio, timer-generated acknowledgements, or invented tool-level full duplex is used.

[4] [Firebase AI Logic Live API model availability](https://firebase.google.com/docs/ai-logic/live-api)
[5] [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
[6] [Gemini Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
[7] [MindPal native-audio provider evidence](./native_audio_provider_evidence_2026-08-18.md)

## Release validation — constrained native-audio retest

The deterministic release gate must pass again after removing the rejected constrained-session field: the JavaScript regressions, prescribed Python suite, syntax/import audit, frontend audit, production build, and immutable-asset verification. An authenticated production call must prove that the native session reaches `Listening`, speaks its greeting, remains open across a second user turn, and does not emit an early provider close. Proactive spoken acknowledgements and provider function calls remain intentionally out of scope for this constrained transport validation.
