# MindPal Voice V3 — Evidence-Driven Production Architecture

**Author:** Manus AI  
**Project:** MindPal  
**Date checked:** 2026-08-21  
**Status:** Architecture blueprint and implementation plan. This document does not claim that Voice V3 has already been implemented or deployed.

## 1. Provider Capability Evidence Ledger

The ledger below separates capabilities documented by Google from capabilities that are merely desirable product behavior. The architecture depends only on capabilities marked **PROVEN**. Capabilities marked **PARTIALLY PROVEN** are runtime-gated. Capabilities marked **UNPROVEN** are never allowed to be the only path to a required user experience.

| Capability | Query used | Best source | Source type | Date checked | Verdict | Evidence summary | Design consequence |
|---|---|---|---|---|---|---|---|
| Full-duplex bidirectional audio streaming | Gemini Live API full-duplex bidirectional audio | [Gemini Live API overview][1] | official docs | 2026-08-21 | **PROVEN** | Google describes Live API as low-latency, real-time interaction over continuous streams and specifies a stateful WebSocket protocol. | Use one stateful Live session for continuous input and streamed output, with separate local audio and control lanes. |
| Continuous microphone input while assistant audio is output | Gemini Live API continuous audio stream barge-in | [Live API overview][1], [Live API capabilities][2] | official docs | 2026-08-21 | **PARTIALLY PROVEN** | Continuous audio input and user interruption are documented, but the provider does not promise an application-specific mixing policy for every browser/audio-device condition. | Keep capture active while output plays, but enforce browser echo cancellation, local VAD, playback ducking, and generation validation. |
| Interruption/barge-in | Gemini Live API interruption VAD barge-in | [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | Google documents VAD interruption and states that interrupted generation is canceled/discarded; clients should stop and clear queued playback. | Provider interruption is a canonical event. The client must immediately duck locally, then flush the invalidated playback generation. |
| Automatic VAD | Gemini Live API automatic VAD | [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | Automatic VAD is enabled by default and can be configured through `realtimeInputConfig.automaticActivityDetection`. | Use provider VAD for turn ownership, with local RMS/VAD only for immediate UX feedback and backchannel eligibility. |
| Custom VAD/activity boundaries | Gemini Live API custom VAD activity start end | [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | Google documents disabling automatic VAD and sending explicit activity-start/activity-end messages for manual control. | V3 may add an explicit-turn mode for deterministic testing and accessibility, but automatic VAD remains the default. |
| Input transcription | Gemini Live API input transcription | [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | `input_audio_transcription` enables transcription of model input audio. | Use provider input transcription as one source for user captions and final-turn assembly. |
| Output transcription | Gemini Live API output transcription | [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | `output_audio_transcription` enables transcription of model audio output. | Use output transcription for assistant captions; still retain a safe fallback to model text parts when allowed. |
| Native audio output | Gemini native audio model capability | [Gemini 3.1 Flash Live model page][3], [Gemini 2.5 Flash Live model page][4] | official docs | 2026-08-21 | **PROVEN** | Both selected model pages list audio generation and Live API support. | Decode provider PCM directly and preserve a stable playback clock; do not represent audio as text-to-speech post-processing. |
| Input audio format | Gemini Live API audio format | [Live API overview][1], [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | Raw 16-bit little-endian PCM is documented; input is natively 16 kHz, and MIME type communicates the rate. | Capture mono PCM16 at 16 kHz and send `audio/pcm;rate=16000`. |
| Output audio format | Gemini Live API output sample rate | [Live API overview][1], [Live API capabilities][2] | official docs | 2026-08-21 | **PROVEN** | Output is raw little-endian 16-bit PCM at 24 kHz. | Playback buffers are created at 24 kHz. If the device clock differs, use an explicit, tested render/resample stage rather than claiming “4K audio.” |
| Function calling/tool calling | Gemini Live API function calling | [Live API tool use][5], [Gemini 3.1 model page][3] | official docs | 2026-08-21 | **PROVEN** | Live API supports function declarations and manual function responses; both selected models list function calling. | Keep tool execution behind the Operation Layer and send responses only after identity and turn validation. |
| Asynchronous function calling in Gemini 3.1 | Gemini 3.1 Live asynchronous function calling | [Live API capabilities][2], [Gemini 3.1 model page][3] | official docs | 2026-08-21 | **UNSUPPORTED** | Google explicitly states asynchronous function calling is not supported in Gemini 3.1 Flash Live; function calling is sequential. | Never design the 3.1 primary path around non-blocking provider functions. Use an independent local/backend operation plus a validated response-injection path. |
| Asynchronous function calling in Gemini 2.5 | Gemini 2.5 Live asynchronous function calling | [Live API capabilities][2], [Live API tool use][5] | official docs | 2026-08-21 | **PROVEN** | Google documents `NON_BLOCKING` functions for Gemini 2.5 and response scheduling values such as `INTERRUPT`, `WHEN_IDLE`, and `SILENT`. | Expose this only in the 2.5 capability manifest. Do not make it a cross-model contract. |
| Provider-generated listening cues/backchannels | Gemini Live API backchannel listening cues | Official Gemini Live API capability pages reviewed; no dedicated provider cue contract found. | official docs | 2026-08-21 | **UNPROVEN** | Google documents audio output, VAD, proactive audio, and affective dialog, but the reviewed official pages do not promise discrete provider-generated listener acknowledgements while a user is speaking. | A mandatory local rule-based BackchannelConductor must guarantee the UX path. Provider cues may be opportunistic and capability-gated, never required. |
| Provider-generated short acknowledgements | Gemini Live API short acknowledgements | Official Gemini Live API capability pages reviewed; no guaranteed acknowledgement vocabulary or timing found. | official docs | 2026-08-21 | **UNPROVEN** | No official contract guarantees specific words or cue timing. | Treat “mhm,” “yeah,” and “go on” as local cue policy outputs, not provider API guarantees. |
| Proactive audio | Gemini Live API proactive audio | [Live API capabilities][2], [Gemini 3.1 model page][3] | official docs | 2026-08-21 | **PARTIALLY PROVEN** | Proactive audio is documented for Gemini 2.5 with `v1beta`, but the same documentation explicitly says it is not supported by Gemini 3.1 Flash Live. | Enable only in the 2.5 manifest after runtime validation. Do not configure or depend on it for the 3.1 primary. |
| Affective dialog | Gemini Live API affective dialog | [Live API capabilities][2], [Gemini 3.1 model page][3] | official docs | 2026-08-21 | **PARTIALLY PROVEN** | Affective dialog is documented for Gemini 2.5 with `v1beta` and explicitly not supported by Gemini 3.1 Flash Live. | Use only as an optional 2.5 capability. Core emotional responsiveness must come from prompt/context and local UX, not this feature. |
| Session resumption | Gemini Live API session resumption | [Session management with Live API][6] | official docs | 2026-08-21 | **PROVEN** | Google documents `sessionResumption`, periodic resumption updates, and reusable handles valid for a stated period after termination. | Store the latest handle and resume before reseeding context. Resume attempts must carry generation identity and a recovery budget. |
| GoAway/transport termination notice | Gemini Live API GoAway | [Session management with Live API][6] | official docs | 2026-08-21 | **PROVEN** | Google documents GoAway with `timeLeft` before a connection terminates. | Treat GoAway as a planned recovery trigger, not as an unexplained fatal error. |
| Generation-complete signaling | Gemini Live API generation complete | [Session management with Live API][6] | official docs | 2026-08-21 | **PROVEN** | Google documents `generationComplete` to indicate model generation finished. | Normalize it separately from turn completion and use the response boundary state machine to prevent late artifacts. |
| Client-to-server direct WebSocket approach | Gemini Live API client-to-server | [Gemini Live API overview][1] | official docs | 2026-08-21 | **PROVEN** | Google documents direct client-to-server WebSocket streaming and recommends ephemeral tokens for production client applications. | Keep the high-bandwidth audio stream direct from browser to Gemini; keep token provisioning and tools on the authenticated backend. |
| Ephemeral-token security | Gemini Live API ephemeral tokens | [Ephemeral tokens][7] | official docs | 2026-08-21 | **PROVEN** | Google documents short-lived tokens, one-session use, configuration constraints, and direct browser connection. | Never place a long-lived Gemini API key in the browser. Lock model/configuration fields where practical and use no-store responses. |
| Provider-native fallback between 3.1 and 2.5 | Gemini Live API model fallback | Official docs document models separately but no provider-managed fallback transaction. | official docs | 2026-08-21 | **UNSUPPORTED** | No provider behavior was found that automatically switches an active session from one model to another without application orchestration. | V3 owns fallback. Never switch models mid-response; activate 2.5 only after a bounded primary startup/transport failure. |
| Gemini 3.1 Flash Live availability | Gemini 3.1 Flash Live model availability | [Gemini 3.1 Flash Live model page][3] | official docs | 2026-08-21 | **PROVEN** | Official model page lists `gemini-3.1-flash-live-preview`, audio input/output, Live API, function calling, search grounding, and thinking. | Use it as the primary only when the backend provisioning check and model capability manifest agree. |
| Gemini 2.5 Native Audio availability | Gemini 2.5 Flash Native Audio model availability | [Gemini 2.5 Flash Live model page][4] | official docs | 2026-08-21 | **PROVEN** | Official model page lists `gemini-2.5-flash-native-audio-preview-12-2025`, audio input/output, Live API, function calling, and thinking. | Use it as the distinct fallback with a separate model manifest and version-specific setup. |

### Evidence conclusion

The selected model strategy is valid, but the desired listener-cue behavior is not an official provider contract. The production-safe interpretation is therefore:

> **Gemini supplies the realtime conversation, native audio, transcription, VAD, interruption, and tools. MindPal supplies deterministic cue timing, lane isolation, caption synchronization, response-boundary enforcement, and fallback behavior.**

## 2. Executive Summary

MindPal Voice V3 should be implemented as a supervised set of isolated browser layers connected through a typed **LayerLink** protocol. The browser should maintain a direct, stateful WebSocket to Gemini Live using a short-lived credential minted by the authenticated backend. Audio must remain on a high-priority stream path, while control messages, captions, tools, recovery, and telemetry use separate bounded queues.

The primary model is `gemini-3.1-flash-live-preview`. The fallback is `gemini-2.5-flash-native-audio-preview-12-2025`. The model router must not switch models during a healthy response. It may activate the fallback only after primary startup or transport failure, before an active conversational response is accepted.

The most important V3 correction is the treatment of backchannels. Google documents low-latency audio, VAD, interruption, transcription, and audio output, but the reviewed documentation does not guarantee discrete “mhm,” “yeah,” or “go on” listener responses. Therefore, the core UX must be guaranteed by a local **BackchannelConductor** that generates short, pre-rendered or local-TTS cues while the user is speaking. Gemini-native cues may be tried only as an optional source behind capability detection and runtime confirmation.

The central correctness rule is generation-based isolation:

```text
An artifact is valid only if its session, turn, response, playback, and operation identity
still match the active orchestrator state and its TTL has not expired.
```

This rule prevents greeting replay, duplicate captions, late PCM, late cues, stale tool results, and old recovery events from entering a new turn.

## 3. Corrected Assumptions and Design Goals

### 3.1 Corrected provider assumptions

The Live API is a stateful WebSocket service with documented raw PCM formats: 16-bit little-endian PCM input, natively 16 kHz, and 16-bit little-endian PCM output at 24 kHz.[1] [2] A browser may connect directly for better streaming latency, but production browser clients should receive short-lived ephemeral credentials rather than a long-lived API key.[1] [7]

Gemini 3.1 and Gemini 2.5 are not interchangeable configuration targets. Gemini 3.1 uses `thinkingLevel`, while Gemini 2.5 uses `thinkingBudget`. Gemini 3.1 may place multiple content parts in a single server event, while the 2.5 comparison path delivers one part per event.[2] The adapter must process every content part rather than assuming one message equals one artifact.

The most important version difference concerns text injection. Google’s 3.1 migration documentation states that `send_client_content` is for seeding initial context history when the relevant history configuration is enabled; ongoing text updates should use realtime input. V3 must therefore expose a model-specific command strategy instead of treating `sendClientContent` as a universal mid-conversation transport.[2] [3]

### 3.2 Product goals

V3 must support continuous microphone capture, assistant speech while the user can interrupt, local listener cues during a long story, full-turn response generation, captions synchronized to playback, clean recovery, secure credentials, and strict stale-artifact rejection.

The design must not claim literal zero latency or “4K audio.” The meaningful target is a studio-like perceptual experience: no clicks, no pops, no choppy chunks, no replayed greetings, no captions racing ahead of sound, and no assistant output globally muted merely because the user is talking.

### 3.3 Current Voice V2 audit

The current Voice V2 implementation already contains many useful primitives: browser capture with echo cancellation and noise suppression, AudioWorklet capture, 16 kHz PCM input, 24 kHz playback buffers, Gemini event normalization, input/output transcript assembly, playback generations, interruption flushing, recovery with resumption handles, local persistence, evidence-gated operations, and stale-audio protection.

However, V2 is still a callback-oriented composition rather than a complete LayerLink architecture. Its main gaps are the absence of a fully versioned inter-layer envelope, explicit bounded flow-control contracts, explicit audio-plane ownership, a mandatory local backchannel guarantee, a dedicated model-router container, per-message TTL/dead-letter handling, and a strict provider-version strategy for ongoing 3.1 text/control injection.

The V2 code also uses a number of direct callbacks between layers. These are functional, but V3 should place them behind typed ports so one layer cannot mutate another layer’s internal state or accidentally reuse an old callback after a generation change.

## 4. High-Level Architecture

```text
                                      SECURITY / CREDENTIAL LAYER
                              authenticated backend + ephemeral token
                                                   │
                                                   ▼
┌──────────────────────┐       control/audio       ┌──────────────────────┐
│ User microphone      │ ────────────────────────► │ CAPTURE LAYER        │
│ browser input device │                           │ Worklet + local VAD   │
└──────────────────────┘                           └──────────┬───────────┘
                                                             │ AudioFrame
                                                             ▼
                                                   ┌──────────────────────┐
                                                   │ TRANSPORT LAYER       │
                                                   │ WSS + bounded queues  │
                                                   └──────────┬───────────┘
                                                              │ raw provider msg
                                                              ▼
                                                   ┌──────────────────────┐
                                                   │ PROVIDER ADAPTER      │
                                                   │ Gemini normalization   │
                                                   └──────────┬───────────┘
                                                              │ Voice events
                                                              ▼
┌──────────────────────┐       commands/events     ┌──────────────────────┐
│ MODEL ROUTER         │ ◄────────────────────────► │ ORCHESTRATOR          │
│ 3.1 primary / 2.5 fb │                           │ canonical state        │
└──────────────────────┘                           └───────┬──────┬───────┘
                                                          │      │
                                  ┌───────────────────────┘      └─────────────────────┐
                                  ▼                                                    ▼
                         ┌──────────────────┐                               ┌──────────────────┐
                         │ TRANSCRIPT LAYER │                               │ PLAYBACK LAYER   │
                         │ partial/final/dedup│                             │ PCM/generations  │
                         └────────┬─────────┘                               └────────┬─────────┘
                                  │                                                     │
                                  ▼                                                     ▼
                         ┌──────────────────┐                               ┌──────────────────┐
                         │ CAPTION LAYER    │ ◄──── playback clock ────────  │ browser speakers │
                         │ paced UI output  │                               │ analyser/compress│
                         └──────────────────┘                               └──────────────────┘

┌──────────────────────┐    isolated cue lane     ┌────────────────────────────┐
│ BACKCHANNEL          │ ◄───────────────────────► │ local rules / optional     │
│ CONDUCTOR            │                           │ native provider cue source │
└──────────────────────┘                           └────────────────────────────┘

┌──────────────────────┐    identity-validated    ┌────────────────────────────┐
│ OPERATION LAYER      │ ◄───────────────────────► │ backend tools / evidence   │
│ tools + cue staging  │                           │ verifier / result injector │
└──────────────────────┘                           └────────────────────────────┘

┌──────────────────────┐                           ┌────────────────────────────┐
│ RECOVERY LAYER       │ ◄──── state/control ─────► │ PERSISTENCE + TELEMETRY    │
│ resume/reseed/fallback│                           │ metrics, diagnostics, logs │
└──────────────────────┘                           └────────────────────────────┘
```

The diagram has three logical planes. The **audio plane** carries microphone frames and output PCM with priority and low latency. The **control plane** carries typed commands and events such as transcript updates, interruption, turn completion, and tool results. The **telemetry plane** carries droppable diagnostics and must never block audio or control processing.

## 5. Layer Inventory

| Layer | Responsibility | Inputs | Outputs | State owned | Failure modes | Backpressure | Stale rejection | Telemetry |
|---|---|---|---|---|---|---|---|---|
| Capture | Acquire microphone, process frames, local VAD/RMS, mute | MediaStream, device frames | `AudioFrame`, quality events | stream, sequence, mute, noise floor | permission denied, worklet failure, device loss | fixed ring buffer; drop oldest non-speech frame only with diagnostic | session generation and frame sequence | frame age, RMS, dropped frames, mute transitions |
| Security/Credential | Authenticate user and mint constrained ephemeral token | Auth/App Check, model policy | token, expiry, constraints | token expiry and grant state | auth failure, expired token, model mismatch | one token request per idempotency key | request ID and model binding | token latency, failures, fallback grant use |
| Transport | Open WSS, send setup/audio/control, receive raw messages | token, setup, audio/control queue | raw provider messages, socket events | socket generation, queue watermarks, health | timeout, close, malformed message, rate limit | bounded audio/control queues; telemetry shedding | socket generation and session generation | setup latency, queue depth, close codes |
| Provider Adapter | Parse Gemini messages and normalize fields | raw provider frames | typed `VoiceEvent` objects | provider event sequence, current aliases | malformed JSON, unknown schema, partial event | reject malformed messages; never retry raw malformed content | socket and provider response identity | normalized event counts, schema rejects |
| Model Router | Select model and configuration | policy, backend token response, health | `ModelLease`, setup config | active model, capability manifest, fallback budget | unsupported model, fallback loop, mid-turn switch | serialize model changes | model lease and session generation | selection/fallback reason, readiness |
| Orchestrator | Own canonical state and coordinate all layers | typed events/commands | validated commands to layers, state projections | session, turn, response, playback, operation identities | invariant violation, duplicate boundary, race | event mailbox with bounded control queue | all identity dimensions plus TTL | transitions, rejected artifacts, invariants |
| Transcript | Assemble partial/final user and assistant text | normalized transcript events | caption candidates, finalized turns | per-lane assemblers and finalization set | cumulative duplication, late snapshot, mute race | cap candidate length and queue count | turn/response identity, completed-turn barrier | dedup counts, finalization latency |
| Playback | Decode, schedule, mix, duck, flush PCM | `AudioChunk` | Web Audio nodes, playback signals | generation, clock, active sources | decode error, clock drift, context suspend | jitter buffer with high/low watermark | playback generation and response identity | queue depth, start latency, underruns, glitches |
| Caption | Render paced captions | transcript candidates, playback start/end | UI caption nodes | visible queue, release clock, drift estimate | late caption, overflow, RTL layout issue | bounded caption queue; coalesce cumulative updates | completed turn and playback generation | caption drift, dropped/merged nodes |
| BackchannelConductor | Decide and play listener cues | local VAD, partial transcript, turn state | `BackchannelCue` on separate lane | cooldown, recent count, cue pending | cue spam, late cue, echo self-capture | one pending cue per turn; max cues per window | cue identity, TTL, active turn | requested, played, canceled, rejected reason |
| Operation | Run tools/evidence and stage thinking cues | finalized turn, tool call | validated result injection | operation controller, concurrency, timeout | timeout, stale result, evidence unavailable | concurrency limit and timeout | session + turn + operation ID | duration, result, cue evidence |
| Recovery | Resume, reseed, fallback, fail gracefully | GoAway, close, error, health | reconnect commands, recovery status | attempts, budget, resume handle | recovery loop, expired token, context loss | bounded attempts and exponential delay | recovery generation and model lease | attempts, outcome, fallback |
| Persistence | Store summary and redacted session record | completed session metadata | local/private record | incognito, bounded record count | storage unavailable, oversized record | retain most recent bounded records | session ID and close state | persistence success/failure |
| Telemetry | Record metrics without affecting behavior | events from all layers | batched/diagnostic payloads | counters and spans | endpoint failure, invalid payload | drop diagnostics first; never block | event timestamp and session ID | all metrics listed in section 16 |

## 6. LayerLink Communication Design

### 6.1 Contract rules

Every layer exposes ports rather than mutable state. A port accepts an immutable command or event and returns an explicit result. The orchestrator is the only owner of canonical session state. The provider adapter is the only component that interprets raw Gemini messages. The playback manager is the only component allowed to schedule provider PCM. The caption renderer is the only component allowed to create or update caption nodes.

Audio and control messages must not share one unbounded queue. Telemetry is lower priority than both and may be dropped. Every message carries identity, timestamp, TTL, causation, and correlation information.

### 6.2 TypeScript-style contracts

```ts
type LayerName =
  | "capture" | "security" | "transport" | "provider-adapter"
  | "model-router" | "orchestrator" | "transcript" | "playback"
  | "caption" | "backchannel" | "operation" | "recovery"
  | "persistence" | "telemetry";

type Priority = "critical" | "high" | "normal" | "low" | "telemetry";
type MessageClass = "command" | "event" | "streamControl" | "ack" | "nack" | "heartbeat" | "telemetry" | "deadLetter";

type GenerationIdentity = {
  sessionGeneration: string;
  turnId: string | null;
  providerResponseId: string | null;
  playbackGeneration: string | null;
};

type OperationIdentity = GenerationIdentity & {
  operationId: string;
};

type BackchannelCueIdentity = GenerationIdentity & {
  cueId: string;
  cueSource: "native" | "local-rules" | "small-model" | "local-audio";
  cueLane: "backchannel";
  createdAtMono: number;
  expiresAtMono: number;
};

type LayerLinkEnvelope<T> = {
  schemaVersion: 1;
  messageId: string;
  messageClass: MessageClass;
  messageType: string;
  sourceLayer: LayerName;
  targetLayer?: LayerName;
  topic?: string;
  priority: Priority;
  timestampMono: number;
  timestampWall: string;
  ttlMs: number;
  identity: GenerationIdentity;
  operation?: OperationIdentity;
  causationId?: string;
  correlationId: string;
  payload: T;
};

type Command<T> = LayerLinkEnvelope<T> & { messageClass: "command" };
type Event<T> = LayerLinkEnvelope<T> & { messageClass: "event" };
type StreamControl<T> = LayerLinkEnvelope<T> & { messageClass: "streamControl" };
type Ack = LayerLinkEnvelope<{ accepted: true; acceptedMessageId: string }> & { messageClass: "ack" };
type Nack = LayerLinkEnvelope<{ accepted: false; code: string; reason: string; retryable: boolean }> & { messageClass: "nack" };
type DeadLetter = LayerLinkEnvelope<{ originalMessageId: string; reason: string; originalType: string }> & { messageClass: "deadLetter" };

type AudioFrame = {
  frameId: string;
  sequence: number;
  sampleRate: 16000;
  channels: 1;
  format: "pcm_s16le";
  data: ArrayBuffer;
  capturedAtMono: number;
  durationMs: 20;
  muted: boolean;
  rms: number;
};

type AudioChunk = {
  chunkId: string;
  sequence: number;
  format: "pcm_s16le";
  sampleRate: 24000;
  channels: 1;
  base64Data: string;
  audioLane: "main" | "backchannel" | "system";
  identity: GenerationIdentity;
};
```

### 6.3 Flow-control policy

The capture-to-transport audio queue is bounded to 250 ms of audio. At the high watermark, the system emits an overload diagnostic and stops admitting additional low-priority telemetry. It never silently drops a frame without recording the sequence range. At the low watermark, normal admission resumes.

The playback jitter queue targets 80–160 ms of scheduled audio. If it exceeds 300 ms, the system coalesces only future caption candidates and does not add more delay to already-started playback. If it underruns, the playback layer emits an underrun metric and continues from the next valid generation.

The backchannel queue permits exactly one pending cue per turn and no more than four cues per 30-second window by default. A cue whose TTL expires is dead-lettered rather than played late.

## 7. Model Router and Gemini Configuration

### 7.1 Model profiles

| Profile | Model ID | API/version policy | Proven strengths | Restrictions |
|---|---|---|---|---|
| Primary | `gemini-3.1-flash-live-preview` | Current backend constrained transport policy; validate against provisioning response | Low-latency audio-to-audio, Live API, audio transcription, function calling, search grounding, thinking | No asynchronous function calling, proactive audio unsupported, affective dialog unsupported, ongoing text updates must use the documented realtime-input path. |
| Fallback | `gemini-2.5-flash-native-audio-preview-12-2025` | `v1beta` capability path | Native audio, Live API, transcription, function calling, asynchronous function calling, proactive audio and affective dialog documented | Preview model; separate thinking configuration and event assumptions; native provider cues still unproven. |

The official 3.1 model page identifies the exact model string and states that it is optimized for low-latency real-time dialogue.[3] The official 2.5 model page identifies the exact native-audio fallback string and lists Live API and audio generation support.[4]

### 7.2 Capability manifest

```ts
type ModelCapabilities = {
  modelId: string;
  apiVersion: "v1alpha" | "v1beta";
  responseAudio: true;
  inputTranscription: boolean;
  outputTranscription: boolean;
  functionCalling: boolean;
  asyncFunctionCalling: boolean;
  proactiveAudio: boolean;
  affectiveDialog: boolean;
  sessionResumption: boolean;
  realtimeTextUpdates: boolean;
  initialClientContent: boolean;
  outputSampleRate: 24000;
  inputNativeSampleRate: 16000;
};
```

The manifest is not marketing metadata. It is an execution guard. If a requested feature is false, the model router must not place that field in the setup payload and the orchestrator must select a different local or backend path.

### 7.3 Configuration examples

```js
const primarySetup = {
  model: "models/gemini-3.1-flash-live-preview",
  generationConfig: {
    responseModalities: ["AUDIO"],
    thinkingConfig: { thinkingLevel: "minimal" },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false,
      prefixPaddingMs: 100,
      silenceDurationMs: 500,
    },
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  },
  sessionResumption: {},
  contextWindowCompression: { slidingWindow: {} },
};

const fallbackSetup = {
  model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
  generationConfig: {
    responseModalities: ["AUDIO"],
    thinkingConfig: { thinkingBudget: 0 },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false,
      prefixPaddingMs: 100,
      silenceDurationMs: 500,
    },
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  },
  sessionResumption: {},
  contextWindowCompression: { slidingWindow: {} },
};
```

The exact transport fields must remain aligned with the selected API version and the official reference. V3 should not send 2.5-only `proactivity` or `enableAffectiveDialog` fields to 3.1. It also must not assume that one server event contains only one artifact, because 3.1 can deliver multiple content parts in one event.[2] [3]

### 7.4 Fallback policy

The backend provisions the primary token first. It returns a signed, short-lived fallback grant only when a distinct fallback is configured. The browser may activate the fallback exactly once for startup or bounded transport failure. A healthy active primary response is never switched to 2.5 because a tool is slow, a caption is late, or the user interrupts.

If fallback activation occurs, the orchestrator increments `sessionGeneration`, closes all primary queues, cancels primary operations, creates a new model lease, and reseeds only validated context. The old primary response cannot produce audio, captions, or tool results afterward.

## 8. Orchestrator State Machine

### 8.1 States

```text
IDLE
CREDENTIAL_ACQUIRING
PROVISIONING
CONNECTING
PROVIDER_READY
GREETING_REQUESTED
LISTENING
USER_SPEAKING
USER_MONOLOGUE_ACTIVE
BACKCHANNEL_ELIGIBLE
ASSISTANT_SPEAKING
BARGE_IN_PENDING
INTERRUPTED
THINKING
OPERATION_PENDING
RECOVERING
RESUMING
FALLBACK_ACTIVATING
CLOSING
CLOSED
FAILED
```

### 8.2 State diagram

```text
 IDLE
  │ start
  ▼
 CREDENTIAL_ACQUIRING ──failure──► FAILED
  │
  ▼
 PROVISIONING ──failure──► FALLBACK_ACTIVATING ──failure──► FAILED
  │                                  │
  ▼                                  └────────success──────► CONNECTING
 CONNECTING ──timeout/error────────► RECOVERING
  │ ready
  ▼
 PROVIDER_READY
  │ send one greeting
  ▼
 GREETING_REQUESTED ──audio/transcript──► ASSISTANT_SPEAKING
  │ turn complete
  ▼
 LISTENING ◄────────────── user speech continues ──────────────┐
  │                                                            │
  ▼                                                            │
 USER_SPEAKING ──long story + eligible──► BACKCHANNEL_ELIGIBLE │
  │                                                            │
  ├──────── model speaking + user speech ──► BARGE_IN_PENDING  │
  │                                                            │
  └──────── final input ──► THINKING / ASSISTANT_SPEAKING ─────┘

 ASSISTANT_SPEAKING ──provider interrupted──► INTERRUPTED
 INTERRUPTED ──replacement response────────► ASSISTANT_SPEAKING
 ASSISTANT_SPEAKING ──turn complete────────► LISTENING
 ANY ACTIVE STATE ──GoAway/close/error─────► RECOVERING
 ANY ACTIVE STATE ──user End───────────────► CLOSING ──► CLOSED
```

### 8.3 Transition table

| From | Event | Guard | Side effects | Next |
|---|---|---|---|---|
| Idle | Start | Authenticated request accepted | Create session generation; request token | CredentialAcquiring |
| CredentialAcquiring | Token ready | Model lease valid | Build version-specific setup | Provisioning |
| Provisioning | Provider connect | Token not expired | Create socket generation | Connecting |
| Connecting | Provider ready | Socket generation current | Set provider ready; send one greeting | ProviderReady / GreetingRequested |
| GreetingRequested | Audio/transcript | Greeting identity current | Schedule caption/audio | AssistantSpeaking |
| AssistantSpeaking | Local speech threshold | Mic not muted; model speaking | Duck main lane; mark pending barge-in | BargeInPending |
| BargeInPending | Provider interrupted | Identity current | Flush old playback generation; reset active AI assembler | Interrupted |
| Interrupted | Replacement PCM | New response identity valid | Schedule replacement audio | AssistantSpeaking |
| UserSpeaking | Long-story timer | Cue cooldown and echo gate pass | Request one backchannel | BackchannelEligible |
| BackchannelEligible | Cue expires/canceled | TTL or turn changed | Cancel and dead-letter cue | UserSpeaking |
| UserSpeaking | Final input | Finalization set does not contain turn | Cancel cues; finalize full text | Thinking or AssistantSpeaking |
| Any active | Turn complete | Current response boundary | Close response; reject late PCM; reset active AI assembler | Listening |
| Any active | GoAway/close/error | Recovery budget remains | Freeze new operations; preserve handle | Recovering |
| Recovering | Resume succeeds | Same logical session | New socket generation | Resuming then Listening |
| Recovering | Resume unavailable | Reseed allowed | New session generation/context | Connecting or FallbackActivating |
| Any active | Stop | User stop or fatal failure | Stop capture/provider/playback; cancel operations | Closing then Closed/Failed |

### 8.4 Invariants

The orchestrator must assert the following invariants in development and diagnostic builds:

```text
A completed response cannot schedule audio.
A completed turn cannot receive a new caption node from a late snapshot.
A cue cannot be played after its TTL or for a different turn.
A tool result cannot be injected if its operation identity is stale.
A muted capture frame cannot reach the provider.
A primary response cannot be switched to fallback mid-response.
A provider raw message cannot reach UI code without adapter normalization.
A layer cannot mutate another layer’s state directly.
```

## 9. Audio Pipeline

### 9.1 Capture path

The capture layer requests a mono microphone stream with browser echo cancellation, noise suppression, and automatic gain control. AudioWorklet is preferred. ScriptProcessor is a compatibility fallback only. Frames are normalized to PCM16 little-endian, 16 kHz, 20 ms preferred duration, with monotonically increasing sequence numbers.

The worklet transfers `ArrayBuffer` data instead of repeatedly copying large arrays on the main thread. Where cross-origin isolation is available, a SharedArrayBuffer ring buffer may be used, but the baseline implementation must work without it.

### 9.2 Input transport

The provider transport encodes each frame only at the provider boundary as Base64 when required by the Gemini WebSocket payload. The internal audio plane uses typed arrays. Each send includes MIME type `audio/pcm;rate=16000` and maintains a bounded send queue.

If the send queue reaches its high watermark, the system records the sequence range and enters degradation mode. It does not block the AudioWorklet. Low-priority telemetry is dropped first. If the audio queue remains overloaded, the session surfaces a reconnect/degraded state rather than silently presenting an incomplete story.

### 9.3 Playback path

Gemini output is decoded from Base64 PCM16 and converted to Float32. Each chunk carries a response and playback generation. Chunks are scheduled against a monotonic Web Audio clock using `nextStartTime` so packet arrival jitter does not produce audible gaps.

The playback graph is:

```text
PCM16 decode → Float32 buffer → per-lane gain → analyser → compressor/limiter → destination
```

Main response audio uses full base gain. Backchannel audio uses lower gain and a short envelope. System sounds use a third lane and cannot share main-response identity.

If the hardware AudioContext sample rate differs from 24 kHz, V3 must choose one tested strategy: create the source buffer at 24 kHz and rely on the browser’s documented rendering conversion, or explicitly resample into a stable device-rate buffer. It must not upsample and label that result “4K.”

### 9.4 Jitter and clock policy

The target output queue is 80–160 ms. The playback manager emits `playback.started`, `playback.chunk-scheduled`, `playback.underrun`, `playback.flushed`, and `playback.ended`. Caption release uses the scheduled playback start timestamp, not the network receipt timestamp.

### 9.5 Ducking and fading

Local barge-in detection ducks main audio within 20 ms toward a gain target of approximately 0.32. Provider interruption confirmation then invalidates the old generation and flushes the old sources. If the provider does not confirm within a bounded interval, V3 retains the duck briefly, then either restores audio or enters recovery based on socket health.

A backchannel cue is never allowed to keep the microphone globally muted. When the main response starts, pending or active backchannel audio is faded or canceled according to its lane policy.

## 10. Full-Duplex Interruption Design

When the user starts speaking while the assistant is talking, the sequence is:

```text
1. Capture continues and local RMS/VAD detects speech.
2. Playback immediately ducks the main lane.
3. Orchestrator marks BARGE_IN_PENDING.
4. Mic frames continue toward Gemini.
5. Gemini VAD reports interrupted=true.
6. Provider adapter emits PROVIDER_INTERRUPTED.
7. Orchestrator cancels pending cues and invalidates old response playback.
8. Playback flushes all sources in the old playback generation.
9. Assistant active transcript assembly resets.
10. The user’s transcript continues accumulating in the current turn.
11. Replacement provider audio is accepted only under a new valid response identity.
12. The final response is generated from the complete accumulated user turn.
```

The key distinction is that **interruption closes the old response, not the user’s entire session**. A replacement response is allowed. `TURN_COMPLETE` closes the response boundary, after which late PCM is rejected until new input opens the next boundary.

## 11. BackchannelConductor Design

### 11.1 Why local fallback is mandatory

The official documentation proves realtime native audio, VAD, and interruption, but it does not prove a discrete provider API for listener acknowledgements such as “mhm,” “yeah,” or “go on.” The local conductor is therefore not an optional enhancement; it is the deterministic fallback required to guarantee the product behavior.

### 11.2 Output lanes

| Lane | Content | Priority | Can interrupt main? | Can close user turn? |
|---|---|---:|---:|---:|
| Main | Full assistant response | High | User barge-in only | Provider turn completion only |
| Backchannel | Short listener cue | Low | No | No |
| System | Errors, connection notices, optional UI sounds | Normal | No | No |

### 11.3 Eligibility signals

The conductor consumes local speech duration, RMS/VAD state, partial transcript flow, story-mode classification, estimated turn-end probability, cue cooldown, recent cue count, main response state, provider native-cue state, and echo-risk state.

A cue is eligible only when the user has been speaking long enough, the turn remains open, the transcript indicates continuation, a short natural pause or safe timing window exists, no main response is starting, no command requiring immediate attention is active, and the cooldown allows a cue.

The conductor suppresses cues when the user appears finished, a final transcript is being committed, a main response starts, echo risk is high, the previous cue is too recent, or the session is recovering.

### 11.4 Source priority

```text
1. Provider-native cue, only if capability-gated and runtime-confirmed.
2. Local deterministic rule cue, mandatory fallback.
3. Optional small cue-selection model, never required for timing.
4. Local pre-rendered audio or local TTS.
```

The default production guarantee should use local pre-rendered or local TTS cues, not a second general-purpose model. This avoids network latency and ensures the cue can start while the main Gemini turn remains open.

### 11.5 Cue lifecycle

```text
eligible → requested → identity validated → scheduled → started
        → completed → cooldown updated → telemetry emitted

Any point before start may transition to canceled or expired.
```

A cue is canceled when the user turn finalizes, a main response starts, the session or turn generation changes, its TTL expires, echo risk rises, or provider interruption invalidates its context.

### 11.6 Timing targets

| Metric | Target | Degradation behavior |
|---|---:|---|
| Local decision to cue playback | <100 ms | Skip cue rather than play late. |
| Cue duration | <900 ms | Clamp or reject longer assets. |
| Minimum interval | 3.5–6 s configurable | Enforce per-turn cooldown. |
| Maximum cues | 2–4 per 30 s configurable | Reject with reason `cooldown`. |
| Late cue count | 0 target | Cancel at turn finalization and record violation. |

### 11.7 Echo protection

All cues use browser echo cancellation, lower gain, short duration, self-audio tags, and likely-echo transcript suppression. The local cue mixer must not feed its own output back into the provider input as user speech. If echo confidence is poor, the conductor suppresses a cue instead of risking a false user transcript or a contaminated turn.

## 12. Transcript and Caption System

The transcript layer owns four distinct streams: user partial, user final, assistant partial, and assistant final. It also owns a fifth filtered stream for internal control content that is never rendered as user-visible speech.

Cumulative provider snapshots are reconciled against the assembler’s current text. Identical snapshots are discarded. A final snapshot after a partial sequence replaces the active text rather than appending a second copy. A finalization set prevents the same logical user turn from being finalized twice.

Caption release is tied to playback scheduling:

```text
provider output transcript
        │
        ▼
active response assembler
        │
        ├── deduplicate / replace cumulative snapshot
        ├── reject closed-turn snapshot
        └── create caption candidate
                     │
                     ▼
             caption pacing queue
                     │
                     ▼
      release against playback-start clock
```

The caption layer maintains a bounded queue. If new cumulative text supersedes unreleased text, it coalesces the candidate. If a caption belongs to a completed response or invalid playback generation, it is dropped and counted.

Arabic and English mixed text must be rendered using Unicode-aware direction handling. The renderer should preserve the original text, use a neutral container with `dir="auto"` semantics or an equivalent direction algorithm, and avoid inserting directional characters into the spoken text unless necessary for layout. Caption font size must use responsive clamping so long text wraps on mobile.

Backchannel captions are hidden by default. If product policy later shows them, they must use a separate subtle cue style and a separate lane identity; they must never become the final assistant caption.

## 13. Tool and Evidence Operation System

Every operation is tied to `sessionGeneration`, `turnId`, and `operationId`. The operation layer supports local deterministic tools, authenticated backend tools, and an evidence verifier for current/fact-sensitive questions.

```text
final user turn
      │
      ▼
intent classification
      │
      ├── ordinary conversation → Gemini main response
      ├── local tool → local executor
      ├── backend operation → authenticated backend executor
      └── volatile fact → evidence gate → verified result
                                      │
                                      ▼
                         response staging / thinking cue
                                      │
                                      ▼
                         identity-checked result injection
```

Operations have a concurrency limit, timeout, abort controller, and cancellation reason. A result is accepted only if the session, turn, operation, and model lease still match. A late result is recorded as stale and discarded.

For Gemini 3.1, do not assume asynchronous provider function calling. Google explicitly documents sequential function calling for 3.1 and says the model will not start responding until the tool response is sent.[2] [3] V3 should therefore keep the user’s audio session alive locally while a backend operation runs, use a local thinking cue if appropriate, and then inject the validated result through the model-version-correct input channel.

For Gemini 2.5, asynchronous function calling and response scheduling are documented.[2] [5] Those features remain opt-in and manifest-gated; they are not part of the common cross-model contract.

## 14. Recovery and Fallback

### 14.1 Failure taxonomy

| Failure | Detection | Containment | Recovery | User-visible behavior |
|---|---|---|---|---|
| Credential rejected | HTTP status or schema validation | No socket opened | Re-authenticate or fail startup | “Voice could not be started securely.” |
| Provider setup timeout | No ready event before 15 s | Stop startup capture/queues | One bounded fallback attempt if eligible | “Connecting…” changes to a concise retry message. |
| Malformed provider message | Adapter parse/schema failure | Drop message only | Continue if socket healthy | No visible change; diagnostic recorded. |
| GoAway | Normalized GoAway event | Freeze new recovery-sensitive operations | Resume with handle | Brief reconnect status if perceptible. |
| Unexpected close | Socket close event | Invalidate socket generation | Resume, then reseed | Keep caption/session context where safe. |
| Late PCM | Closed response barrier or stale generation | Drop before playback | None | No replay. |
| Late caption | Closed turn or stale playback | Drop/coalesce | None | No duplicate caption. |
| Late cue | TTL/turn mismatch | Cancel/dead-letter | None | No late “mhm.” |
| Stale tool result | Operation identity mismatch | Discard result | None | Current turn remains uncontaminated. |
| Mic permission/device failure | `getUserMedia` or track error | Stop capture only | Allow user retry | Explain microphone state without destroying chat history. |
| Audio underrun | Playback queue low watermark | Continue with next valid chunk | Reconnect only if persistent | Briefly degrade; record metric. |
| Echo/self-cue transcript | Echo detector and repeated cue text | Suppress transcript candidate | Continue current turn | No false user message. |

### 14.2 Recovery order

```text
GoAway or unexpected close
        │
        ├── latest session-resumption handle available?
        │       └── yes → resume same logical session
        │
        ├── resumption unavailable or rejected?
        │       └── reseed a fresh transport with validated context
        │
        ├── primary startup/transport failure and fallback grant unused?
        │       └── activate Gemini 2.5 once
        │
        └── budget exhausted → graceful FAILED state
```

During recovery, new backchannel requests are suppressed, pending cues are canceled, main playback is flushed, and captions are held until a new valid response boundary exists. The microphone may remain locally open only if the provider path can safely resume; otherwise capture is paused and the user is told why.

## 15. Security and Privacy

The backend authenticates the user, rate-limits token and operation endpoints, and mints a short-lived ephemeral token. Google documents that ephemeral tokens are intended for direct browser-to-Live connections and can be restricted to a model and configuration.[7]

The browser must never contain a long-lived Gemini API key. Token responses use `Cache-Control: no-store`. Fallback grants are signed, user-bound, model-bound, short-lived, and single-use.

Mute is a local privacy boundary. It disables the microphone track and suppresses queued capture frames without closing the provider session. End explicitly closes the session and disposes audio resources. Incognito mode prevents the call from being persisted in local history.

The telemetry layer must not receive raw speech, raw PCM, private transcript content, or tool arguments unless a separately reviewed privacy policy permits it. Production diagnostics should use counts, durations, hashes, reason codes, and bounded sanitized metadata.

## 16. Observability

### 16.1 Realtime metrics

These metrics should be available during a session: capture frame age, input queue depth, output queue depth, local RMS/noise floor, barge-in detection-to-duck time, provider interruption latency, playback start latency, playback underruns, active generation, and current state.

### 16.2 Batched session metrics

At session close, record session startup time, credential latency, setup latency, first greeting audio, first response audio, user-stop-to-response latency, turn count, interruption count, caption drift, cue count, operation durations, recovery attempts, fallback activation, and cleanup completeness.

### 16.3 Diagnostic-only metrics

The following should be diagnostic-only and sampled or rate-limited: malformed provider message details, stale artifact identity summaries, frame sequence ranges, queue-overflow reasons, echo-risk decisions, native-cue confirmation timing, and provider close metadata.

```text
voice.session.started
voice.credentials.ready
voice.provider.ready
voice.greeting.sent
voice.capture.frame.dropped
voice.playback.started
voice.playback.underrun
voice.caption.drift
voice.bargein.ducked
voice.provider.interrupted
voice.stale.artifact.rejected
voice.backchannel.requested
voice.backchannel.played
voice.backchannel.canceled
voice.backchannel.rejected
voice.operation.started
voice.operation.completed
voice.recovery.started
voice.recovery.resumed
voice.fallback.activated
voice.session.closed
```

## 17. Performance Budget

| Metric | Target | Measurement point | Degradation behavior |
|---|---:|---|---|
| Capture frame duration | 20 ms preferred | Worklet frame metadata | Increase batching only within bounded 40 ms ceiling; record deviation. |
| Worklet-to-send handoff | <10 ms normal | Frame captured to provider send | Shed telemetry; never block worklet. |
| Local barge-in duck | <20 ms | RMS threshold to gain target | Keep local duck independent of provider confirmation. |
| Provider audio receipt to playback schedule | <80 ms warm graph | Adapter event to `source.start` | Skip stale chunk rather than build an old queue. |
| Local cue decision to playback | <100 ms | Conductor decision to source start | Cancel late cue. |
| Caption drift | <80 ms normal | Scheduled audio clock vs caption release | Coalesce/re-time unreleased candidate. |
| User stop to first main audio | <350 ms excluding provider/network | Final user speech to playback start | Show concise thinking cue only when evidence-backed. |
| Setup ready | <15 s hard timeout | token request to provider ready | One bounded fallback/recovery attempt. |
| Backchannel interval | 3.5–6 s default | Cue start timestamps | Suppress excessive cues. |
| Queue memory | Fixed bounded limits | Queue counters | Drop telemetry first; fail visibly if audio cannot be sustained. |

## 18. Failure Modes and Mitigations

| Failure mode | Root cause | Preventive design | Verification |
|---|---|---|---|
| Greeting replays | Late PCM or cumulative transcript after completion | Closed response barrier, greeting-once flag, completed-turn caption barrier | Start session, wait for completion, assert one greeting audio generation and one assistant caption node. |
| Captions duplicate | Provider sends incremental and cumulative snapshots | Active-turn assembler, snapshot replacement, duplicate-key suppression | Feed repeated snapshots and assert one visible logical response. |
| Captions disappear | Adapter misses provider alias or processes only one 3.1 content part | Normalize all aliases; process every content part | Fixture with audio and transcript in one server event. |
| User speech is lost during long story | Main response or cue path blocks capture | Independent capture/audio plane and bounded queues | Synthetic 60-second transcript/audio stream with cue insertions. |
| “Thinking” appears with no speech | UI trusts request rather than delivered cue | Require matching cue audio and transcript evidence | Force cue request failure and assert no false started state. |
| Mute ends call | Mute sends stream end or closes provider | Local track disable plus silent keepalive; no session stop | Toggle mute/unmute and assert socket/session generation unchanged. |
| User hears old answer after interruption | Old playback sources remain scheduled | Playback generation invalidation and flush | Schedule chunks, interrupt, inject late chunks, assert old sources never start. |
| Backchannel becomes main answer | Shared lane or identity missing | Dedicated backchannel lane and cue identity | Inject cue and main audio interleavings; assert lane separation. |
| Self-echo becomes user speech | Cue/audio leaks into microphone | Browser AEC, self-audio tag, echo transcript suppression | Feed cue-shaped transcript after local cue and assert suppression. |
| Fallback contaminates primary | Model switch without generation barrier | Model lease, session generation increment, queue invalidation | Fail primary startup and inject late primary audio after fallback starts. |
| Tool result contaminates next turn | Async result arrives after user changed topic | Operation identity and cancellation | Complete old operation after new turn; assert no result injection. |
| Reconnect loop | Close events trigger unbounded recovery | Recovery budget, backoff, terminal state | Chaos test repeated close/GoAway events. |
| Browser audio stalls | Suspended context or worklet failure | Resume context, fallback processor, health metrics | Browser compatibility matrix and forced context suspend. |

## 19. Implementation Roadmap

### Phase 0 — Contracts and types

Create `LayerLink` envelopes, identity types, event schemas, TTL rules, queue policies, invariants, and dead-letter diagnostics. Exit criteria: every layer has an immutable port; no new direct cross-layer mutation is introduced; contract tests reject stale identities.

### Phase 1 — Audio capture and playback core

Move capture frames to a bounded audio plane with sequence numbers. Add explicit playback lanes, jitter watermarks, fade/duck envelopes, and clock metrics. Exit criteria: synthetic PCM plays continuously, interruptions flush old generations, and queue bounds hold under overload.

### Phase 2 — Provider adapter and orchestrator

Make the adapter the sole raw-message interpreter. Normalize multi-part Gemini 3.1 events, input/output transcription aliases, interruptions, generation completion, turn completion, and GoAway. Exit criteria: fake-provider tests cover every event and no raw provider payload reaches UI code.

### Phase 3 — Model router and recovery

Create primary/fallback model manifests, configuration validators, readiness timeout, model lease, resumption handling, reseed policy, and single-use fallback activation. Correct the 3.1 ongoing text/control injection path using the documented model-specific transport. Exit criteria: primary cannot switch mid-response; fallback cannot reuse stale queues; all setup fields are capability-gated.

### Phase 4 — Transcript and caption synchronization

Separate user/assistant assemblers, cumulative snapshot replacement, finalization barriers, closed-turn rejection, RTL/Arabic-English rendering, bounded caption queue, and scheduled playback release. Exit criteria: no duplicate final captions, no internal plan text, no late caption nodes, and drift remains within target under simulated jitter.

### Phase 5 — BackchannelConductor and operations

Implement the mandatory local cue source, optional provider cue adapter, cue identity and TTL, echo protection, cooldown, story-mode eligibility, operation staging, evidence gating, and late-result cancellation. Exit criteria: local cue plays while user input continues, cue never closes the user turn, and complete story context reaches the main response.

### Phase 6 — Telemetry and hardening

Add metrics, privacy-safe diagnostics, chaos tests, browser matrix, load/queue tests, and production canary gates. Exit criteria: all anti-regression tests pass, recovery budgets are proven, and production canary shows no replay, stale audio, duplicate captions, or mute session termination.

## 20. Test Plan

### Unit tests

Test PCM16 decoding, frame sequencing, RMS/VAD thresholds, mute suppression, identity matching, TTL expiry, cue cooldown, caption direction selection, cumulative snapshot replacement, finalization idempotency, state transitions, and model capability validation.

### Fake-provider integration tests

A deterministic fake Live provider must emit setup, audio plus transcript in one event, partial and cumulative snapshots, interruption, turn completion, GoAway, generation complete, function call, malformed message, late audio, and stale socket events. The test harness must verify the full event path through the adapter, orchestrator, transcript, playback, and caption ports.

### Audio clock tests

Generate synthetic PCM files for silence, speech-like amplitude envelopes, continuous speech, short pauses, background noise, and interruption bursts. Feed them into the capture and playback layers while varying packet delay and jitter. Assert queue bounds, contiguous playback scheduling, duck latency, underrun metrics, and caption drift.

### Race-condition tests

Cover these orderings:

```text
turnComplete → late PCM
turnComplete → late cumulative transcript
mute toggle → queued capture frame
provider interruption → replacement PCM
user turn final → pending cue audio
operation complete → new user turn
primary close → fallback audio
socket replacement → old socket message
```

Every sequence must assert that no stale artifact reaches the active UI or speaker path.

### Backchannel tests

Test long-story mode with continuous speech and natural pauses. Assert that a local cue can start without closing the user turn, that at most one cue is pending, that cue intervals are respected, that the cue is canceled when the user finishes, and that the complete transcript is used for the final main response.

Test provider-native cue opportunism separately. If no provider cue arrives within its TTL, the local conductor must continue without waiting and must not produce a duplicate local cue when a valid native cue is confirmed.

### Recovery chaos tests

Inject setup timeout, socket failure, GoAway with and without resumption handle, expired token, fallback provisioning failure, repeated close events, and context reseed failure. Assert bounded recovery attempts, no infinite Connecting state, no model contamination, and graceful failure.

### Browser compatibility tests

Test Chromium with AudioWorklet, a browser without AudioWorklet using the fallback processor, suspended AudioContext, denied microphone permission, device removal, mobile viewport caption wrapping, Arabic-English mixed text, reduced-motion preference, and mute/unmute transitions.

### Production canary tests

Before widening deployment, execute a non-persistent canary covering:

```text
start → one greeting → greeting completes → no replay
long story → local cue while speaking → complete final answer
assistant answer → user interruption → old audio flushed
mute → session remains alive → unmute
volatile question → evidence operation → verified response
provider failure → bounded recovery or fallback
stop → complete cleanup and no stale callbacks
```

## 21. Assumptions and Open Questions

1. **Provider-native backchannels remain unproven.** The local deterministic conductor is mandatory and should be the product guarantee.
2. **Gemini 3.1 ongoing text injection requires version-correct handling.** The official migration page says `send_client_content` is for initial history and realtime input should be used for ongoing text updates.[2] [3] V3 must validate the exact constrained WebSocket payload in integration tests before changing the production path.
3. **AudioContext device-rate behavior must be measured.** Provider output is 24 kHz; the design does not claim that creating a 24 kHz source automatically provides a 48 kHz studio signal.
4. **Browser echo cancellation quality varies by device.** Cue suppression must fail closed when echo confidence is poor.
5. **The backend must remain the authority for model policy and credential issuance.** The browser may report capabilities but cannot elevate them.
6. **Provider session duration and connection lifetime are bounded.** Google documents a connection lifetime around ten minutes and recommends resumption/context compression for longer sessions.[6]
7. **V3 is a blueprint, not the current deployed implementation.** The current production Voice V2 commit remains the deployed baseline until each roadmap phase has passed its exit criteria.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api "Gemini Live API overview — Google AI for Developers"

[2]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Live API capabilities guide — Google AI for Developers"

[3]: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview "Gemini 3.1 Flash live preview — Google AI for Developers"

[4]: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025 "Gemini 2.5 Flash live preview — Google AI for Developers"

[5]: https://ai.google.dev/gemini-api/docs/live-api/tools "Tool use with Live API — Google AI for Developers"

[6]: https://ai.google.dev/gemini-api/docs/live-api/session-management "Session management with Live API — Google AI for Developers"

[7]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens "Ephemeral tokens — Google AI for Developers"

---

**Final engineering position:** MindPal can build a robust Voice V3 on Gemini Live without changing the model family, but it must stop treating native listener backchannels as a guaranteed Gemini feature. Gemini should own realtime understanding and primary response generation; MindPal should own deterministic cue timing, isolation, audio/caption synchronization, recovery, and safety boundaries.
