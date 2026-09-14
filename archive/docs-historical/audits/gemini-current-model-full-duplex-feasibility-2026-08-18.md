# MindPal Voice: Gemini Model Analysis and Full-Duplex Feasibility Without Changing Models

**Date:** 2026-08-18
**Repository:** `M1rw/MindPal`
**Audited commit:** `133ffc8`
**Author:** Manus AI

## Question being answered

The question is whether MindPal can become a **full-duplex voice system** using the Gemini voice model it already has, rather than switching models. This analysis first identifies the exact model and transport currently configured, then separates what Google’s model supports from what MindPal currently enables, and finally describes the minimum architecture changes required.

## Short answer

**Yes, MindPal can move toward full-duplex operation without changing the Gemini model.** The current model is designed for low-latency bidirectional voice, and the Live API supports simultaneous continuous audio input and streamed audio output, automatic VAD, and user barge-in.[1] [2]

However, MindPal is not currently using the model’s full interaction surface. The source deliberately disables provider functions, non-blocking function calling, proactive audio, and affective dialog on the current browser ephemeral-token transport.[3] The result is that the system has **full-duplex transport capability**, but not yet a fully expressive full-duplex conversation architecture.

The main work is therefore in **transport capability validation, VAD/turn ownership, playback generation control, and runtime decomposition**—not in replacing Gemini.

## 1. Which Gemini model does MindPal use today?

### Repository truth

The backend default is:

```text
gemini-2.5-flash-native-audio-preview-12-2025
```

This is declared as `GEMINI_LIVE_MODEL` in `backend/core/config.py`. The backend can still be overridden by an environment variable, so this is the **source default**, not absolute proof of the deployed production value unless the production environment is inspected.[4]

The frontend independently defines the same native-audio model in `frontend/js/voice/provider_policy.js`.[3]

| Property | Current MindPal value |
| --- | --- |
| Model ID | `gemini-2.5-flash-native-audio-preview-12-2025` |
| Google API family | Gemini Live API |
| Backend API version selected | `v1beta` for this model prefix |
| Browser transport | Direct browser WebSocket to Gemini |
| Credential | One-use ephemeral token minted by FastAPI |
| Input audio | Raw PCM, nominally 16 kHz, mono, 16-bit |
| Output audio | Raw PCM, 24 kHz |
| Output modality | `AUDIO` |
| Voice | `Kore` |
| VAD | Automatic VAD enabled |
| Interruption | `START_OF_ACTIVITY_INTERRUPTS` |
| Input transcription | Enabled |
| Output transcription | Enabled |
| Session resumption | Enabled when a provider handle exists |
| Context compression | Sliding-window compression enabled |

The backend creates the ephemeral token using the server-side Gemini API key, constrains the token to audio responses and session resumption, and returns the provider WebSocket URL to the browser.[5] The browser then appends the ephemeral token to the WebSocket URL and sends the setup message directly to Gemini.[6]

### Important configuration caveat

The repository contains older documents describing `gemini-3.1-flash-live-preview`, `v1alpha`, and a different provider capability profile. The current source defaults and frontend policy point to Gemini 2.5 native audio and `v1beta`, while some documentation still describes the older Gemini 3.1 path.[7] This is configuration/documentation drift and should be removed before changing Voice behavior.

## 2. What Google officially says this model supports

Google’s current model page identifies `gemini-2.5-flash-native-audio-preview-12-2025` as a Live API model with audio, video, and text inputs; audio and text outputs; audio generation; function calling; search grounding; thinking; and Live API support.[1]

Google’s Live API overview describes the API as processing continuous streams of audio, video, or text and delivering low-latency spoken responses. It explicitly lists barge-in, tool use, audio transcriptions, proactive audio, and affective dialog as Live API capabilities.[2]

For the specific Gemini 2.5 versus Gemini 3.1 distinction, Google’s capability table states that Gemini 2.5 Flash Live supports:

| Capability | Gemini 2.5 Flash Live status | Meaning for MindPal |
| --- | --- | --- |
| Continuous bidirectional audio | Supported | The browser can send microphone audio while receiving model audio |
| Automatic VAD | Supported | Gemini can own speech start/end detection |
| Custom VAD | Supported | MindPal can use client-side signals to finalize turns when necessary |
| Barge-in/interruption | Supported | User speech can cancel model generation |
| Input/output transcription | Supported | MindPal can maintain captions and semantic state |
| Function calling | Supported | Tools can be declared and executed |
| Non-blocking function calling | Supported | Model can continue interacting while a tool runs, subject to transport validation |
| Tool response scheduling | Supported | Tool results can be delivered as `INTERRUPT`, `WHEN_IDLE`, or `SILENT` |
| Proactive audio | Supported on the model, requiring the appropriate setup/API configuration | Model can decide not to respond to irrelevant input |
| Affective dialog | Supported on the model, requiring the appropriate setup/API configuration | Model can adapt style to vocal expression |
| Native audio | Supported | Audio is generated as a native voice response rather than a separate TTS stage |

Google’s comparison also states that Gemini 2.5 Flash Live supports `behavior: NON_BLOCKING` for function declarations and scheduling values such as `INTERRUPT`, `WHEN_IDLE`, and `SILENT`, while Gemini 3.1 Flash Live does not.[8]

## 3. What MindPal currently enables versus disables

This is the most important distinction. The model is capable of more than the current MindPal transport configuration exposes.

| Feature | Gemini 2.5 model capability | MindPal current source behavior | Reason/status |
| --- | --- | --- | --- |
| Continuous microphone input during model playback | Supported by Live API | Partially enabled | Capture continues, but local policy and provider interruption still govern what becomes semantic activity |
| Model audio while user is speaking | Transport can carry both directions | Not treated as a stable product behavior | Provider interruption normally cancels the current generation; MindPal clears queued audio on interruption |
| Barge-in | Supported and currently configured | Enabled | `START_OF_ACTIVITY_INTERRUPTS` plus provider `interrupted` event handling |
| Non-blocking tools | Supported by model | **Disabled** | `nonBlockingFunctions: false` in provider policy |
| Provider-declared tools | Supported by model | **Disabled for native-audio path** | `providerFunctions: !nativeAudio`, so current native model setup omits tools |
| Proactive audio | Supported by model | **Disabled** | Current constrained ephemeral-token path previously rejected `setup.proactivity` with a setup error according to repository comments |
| Affective dialog | Supported by model | **Disabled** | Current provider policy sets `affectiveDialog: false` |
| Listening backchannel | Could be approximated through model output | **Disabled** | `speakListeningPresence: false` |
| Current-fact search | Model capability exists, but MindPal does not use provider search here | Backend verifier only | Deliberate freshness/security gate |
| Audio output | Native 24 kHz PCM | Enabled | Browser schedules PCM chunks through Web Audio |

The current provider policy is explicit: native-audio provider functions are off because the free-tier preview and current constrained ephemeral-token transport previously closed the WebSocket after the first greeting when provider functions were present; proactive audio and affective dialog are also disabled because the current constrained setup rejected the relevant configuration.[3]

Therefore, the current limitation is not simply “Gemini cannot do full duplex.” It is:

> **Gemini 2.5 can support the required interaction model, but MindPal’s currently validated browser transport intentionally runs a conservative subset of that capability.**

## 4. What “full duplex” should mean for MindPal

The phrase can refer to three different levels:

| Level | Definition | Current status |
| --- | --- | --- |
| **Transport duplex** | Browser continuously sends microphone PCM while simultaneously receiving model PCM | **Already mostly present** |
| **Conversation duplex** | User can interrupt naturally, model audio is cancelled immediately, and the next user turn takes ownership without stale playback | Partially present; needs stronger turn/playback identity |
| **Expressive duplex** | Model can use non-blocking tools, natural backchannels, proactive response decisions, affective style, and carefully scheduled overlap | Not currently enabled; requires transport capability validation and runtime changes |

The correct target for MindPal is not “let both sides talk over each other constantly.” That would create an unpleasant and unsafe conversation. The target should be:

> **Continuous simultaneous audio transport, provider-owned barge-in, low-latency turn exchange, and optional model backchannels or proactive behavior that never compete with user speech.**

Google’s VAD behavior is important here: when VAD detects an interruption, the ongoing generation is cancelled and discarded, and the client is expected to stop playback and clear queued audio.[8] This means full duplex does not mean the model’s current answer should continue speaking over the user. It means the transport is simultaneous and interruption is immediate.

## 5. Is MindPal already technically full duplex at the audio layer?

**Almost, but not reliably enough at the product layer.**

The runtime sends microphone PCM through `realtimeInput.audio` whenever the local gate is open, including while model/tool work is active.[9] It receives model PCM in WebSocket events and schedules it to Web Audio.[10] The provider setup uses `START_OF_ACTIVITY_INTERRUPTS`, and the runtime clears playback only after the provider reports interruption.[11]

Those are the core ingredients of duplex audio.

The weaknesses are around coordination:

1. **There is no explicit duplex session state.** `sessionPhase`, `isAiSpeaking`, `speechSeenRecently`, `_inputTurnActive`, `_semanticUserTurnActive`, queued audio count, tool state, and evidence state jointly approximate it.[9]
2. **Playback has no generation identity.** An old `AudioBufferSource` callback can occur after an interruption or reconnect and still mutate shared playback state.[10]
3. **Provider interruption and local barge-in state are separate.** Local capture sets `interrupting`, but provider `interrupted` is the authority that actually flushes audio.[11]
4. **Internal control text shares `realtimeInput.text` with conversation input.** Greetings, evidence bridges, local-time results, lifecycle notices, and research updates are injected into the same provider input lane.[9]
5. **Provider tools are disabled.** This prevents the model from using the 2.5 model’s non-blocking function-calling capability in the current path.[3]

## 6. What must change without changing the model

### A. First: prove the current transport can safely expose 2.5 features

Do not immediately turn on every capability in production. Create a capability probe against the exact current model, API version, ephemeral-token flow, account/project, and constrained WebSocket endpoint.

The probe should run these setups independently:

| Probe | Setup change | Pass criteria |
| --- | --- | --- |
| Duplex audio | Existing audio setup with continuous mic capture and playback | Mic frames continue while model audio is queued; no dropped input due to playback |
| Barge-in | `START_OF_ACTIVITY_INTERRUPTS` | User speech produces `interrupted`, queued audio is cleared, and new turn begins |
| Non-blocking function | One harmless `NON_BLOCKING` local test function | Model continues naturally while tool runs; tool result scheduling behaves correctly |
| `WHEN_IDLE` tool result | Tool returns after the model starts speaking | Result is incorporated only at idle, without cutting user speech |
| `SILENT` evidence result | Simulated verified-fact result | Result does not create a competing spoken response before the gate opens |
| Proactive audio | Enable only in a separate probe | Setup succeeds and model can choose not to respond without destabilizing the socket |
| Affective dialog | Enable only in a separate probe | Setup succeeds and output changes appropriately without unacceptable latency |
| Reconnect/resumption | GoAway during capture and playback | Fresh one-use token plus resumption handle retains continuity without duplicate greeting |

The probe must be tied to a provider capability profile and stored as a tested result, not inferred from the model documentation alone.

### B. Second: separate transport duplex from semantic turn ownership

Introduce a `DuplexSessionState` or `VoiceSessionOrchestrator` that owns explicit states such as:

```text
IDLE
CONNECTING
LISTENING
USER_SPEAKING
MODEL_SPEAKING
USER_INTERRUPTING_MODEL
MODEL_THINKING_WITH_TOOL
MODEL_SPEAKING_WITH_TOOL_PENDING
RECOVERING
STOPPING
```

The key rule is that **audio transport may be simultaneous even when semantic turn ownership is not**. Microphone frames can continue to flow while the model speaks, but provider VAD decides whether those frames are an interruption, a continuation, or background noise.

### C. Third: add turn, response, and playback generations

Every asynchronous artifact should carry:

```text
sessionGeneration
turnId
providerResponseId
playbackGeneration
```

Then enforce:

```text
if artifact.turnId !== currentTurnId: discard
if artifact.playbackGeneration !== currentPlaybackGeneration: discard
if artifact.sessionGeneration !== currentSessionGeneration: discard
```

This is the single most important change for making duplex behavior reliable. It prevents old audio, old evidence, old background research, and old reconnect callbacks from affecting the current conversation.

### D. Fourth: use Gemini 2.5 non-blocking tools deliberately

Once the exact transport passes the capability probe, re-enable provider tool declarations for only safe tools first. For example:

```json
{
  "name": "get_user_profile",
  "behavior": "NON_BLOCKING"
}
```

Then use scheduling by tool category:

| Tool category | Suggested scheduling |
| --- | --- |
| Local deterministic time/calculation | `SILENT` or immediate local handling |
| Memory/profile lookup | `WHEN_IDLE` |
| Background research | `WHEN_IDLE` |
| Current-fact verification | `SILENT` until backend evidence is attached to the active turn |
| User-confirmed urgent action | Explicit product-specific policy; never implicit interruption |

The model should not directly control the freshness gate. MindPal should still own the verified-fact policy and use the backend route for current facts.

### E. Fifth: implement safe full-duplex playback

The browser playback path should be extracted into a `PlaybackManager` that owns:

- PCM decoding and sample-rate assumptions.
- A playback queue keyed by `playbackGeneration`.
- Immediate fade/clear on provider interruption.
- A single `isPlaying` projection derived from active generation only.
- No-op `onended` handlers for stale generations.
- Optional ducking rather than hard mute for a very short provider transition, if testing shows it improves naturalness.

Do not let `runtime.js` directly mutate `activeAudioSources`, `nextPlaybackTime`, and `isAiSpeaking` after this extraction.

### F. Sixth: use the model’s supported native-audio features only after transport stability

For the current Gemini 2.5 model, the potential feature order is:

1. Continuous input plus reliable barge-in.
2. Non-blocking tools with `WHEN_IDLE` scheduling.
3. Safe listening acknowledgements, only if they do not compete with user speech.
4. Affective dialog, after latency and safety evaluation.
5. Proactive audio, only after verifying the current constrained token/WebSocket path accepts the setup.

The last two should not be enabled merely because the model page says the model supports them. MindPal’s own provider policy records that the current transport rejected proactive setup and that provider functions destabilized the first greeting in a prior production test.[3]

## 7. Important limitation: session duration

Google’s Live API capability guide currently states that audio-only sessions are limited to **15 minutes**, while audio-plus-video sessions are limited to 2 minutes, with session-management techniques available for extensions.[8]

MindPal’s product policy currently defines a 30-minute maximum call and reconnects before/around provider transport limits.[12] That can be compatible only if MindPal treats the 30-minute call as a product session composed of multiple provider sessions. It must not assume one Gemini WebSocket can remain active for 30 minutes.

The reconnect/resumption path therefore becomes a first-class part of full-duplex reliability. During reconnect, MindPal must preserve:

- The product call ID.
- Current turn identity.
- Playback generation.
- User/model continuity summary.
- Whether an interruption was in progress.
- Whether a tool/evidence result belongs to the pre- or post-reconnect turn.

## 8. Recommended no-model-change architecture

```text
Browser UI
   |
   v
VoiceSessionOrchestrator
   |
   +-- CaptureAdapter
   |     +-- microphone PCM
   |     +-- local quality meter
   |     +-- optional hybrid VAD finalization
   |
   +-- GeminiLiveAdapter
   |     +-- WebSocket
   |     +-- setup/capability profile
   |     +-- normalized provider events
   |
   +-- TurnManager
   |     +-- semantic ownership
   |     +-- turnId and responseId
   |     +-- interruption rules
   |
   +-- ToolGateway
   |     +-- local deterministic tools
   |     +-- backend verified tools
   |     +-- no implicit browser fallback
   |
   +-- EvidenceGate
   |     +-- volatile-fact classifier
   |     +-- backend evidence
   |     +-- turn-scoped release
   |
   +-- PlaybackManager
   |     +-- PCM queue
   |     +-- playbackGeneration
   |     +-- interruption flush
   |
   +-- TransportSupervisor
   |     +-- one-use token refresh
   |     +-- GoAway/resumption
   |     +-- 15-minute provider session renewal
   |
   +-- SessionPersistence
         +-- structured close reason
         +-- transcript and incomplete-turn handling
```

## 9. Decision

The current Gemini model is a suitable foundation for MindPal full duplex. Changing models is **not required** for the first implementation. The safest approach is:

1. Confirm the actual deployed `GEMINI_LIVE_MODEL` value; do not rely only on the source default.
2. Treat `gemini-2.5-flash-native-audio-preview-12-2025` as the current target profile.
3. Keep the current backend verified-fact gate and ephemeral-token security model.
4. Prove the exact `v1beta` constrained WebSocket supports non-blocking functions and any desired proactive/affective setup in a dedicated capability probe.
5. Refactor turn and playback ownership before enabling more expressive features.
6. Re-enable capabilities incrementally, with full-session trace tests.

**Bottom line:** MindPal already has the transport foundation for full duplex. The current system feels less than full duplex because the browser runtime does not yet expose the model’s concurrency safely. The necessary change is to make concurrency explicit and turn-scoped, then selectively unlock the Gemini 2.5 capabilities that the exact production transport proves stable.

## References

[1]: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025 "Gemini 2.5 Flash Native Audio model page"
[2]: https://ai.google.dev/gemini-api/docs/live-api "Gemini Live API overview"
[3]: ../../frontend/js/voice/provider_policy.js "MindPal provider capability policy"
[4]: ../../backend/core/config.py "MindPal backend model configuration"
[5]: ../../backend/api/voice_router.py "MindPal ephemeral voice-token route"
[6]: ../../frontend/js/voice/startup_helpers.mjs "MindPal token and WebSocket startup helpers"
[7]: ../../docs/voice_layered_redesign_audit.md "MindPal historical Voice architecture audit and provider configuration notes"
[8]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capabilities guide"
[9]: ../../frontend/js/voice/runtime.js "MindPal microphone capture and internal input handling"
[10]: ../../frontend/js/voice/runtime.js "MindPal PCM playback queue"
[11]: ../../frontend/js/voice/conversation_policy.js "MindPal provider interruption and capture policy"
[12]: ../../frontend/js/voice/session_policy.js "MindPal product session lifecycle policy"

> **Confidence statement:** I am highly confident about the model configured by the repository source and about Google’s documented Gemini 2.5 Live capabilities. I am less certain about the exact deployed model because `GEMINI_LIVE_MODEL` can be overridden by the production environment; that must be confirmed from deployment configuration before enabling features.
