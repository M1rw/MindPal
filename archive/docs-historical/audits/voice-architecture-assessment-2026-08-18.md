# MindPal Voice-System Architecture Assessment

**Date:** 2026-08-18
**Repository:** `M1rw/MindPal`
**Commit audited:** `133ffc8` (`fix(voice): remove unsupported native proactivity`)
**Author:** Manus AI

## Goal and scope

The goal of this audit was to determine why MindPal’s Voice system feels weak, disorganized, and unreliable, and to identify the architectural changes required to make it coherent. “Done” for this audit means that the active voice path is mapped from microphone capture through provider transport, model/tool decisions, playback, recovery, and post-call persistence; the main risks are supported by repository evidence; and the recommendations are ordered by impact and dependency.

The assessment focused on the active native-audio browser path, its FastAPI token and verification endpoints, the Camb TTS path, browser-side voice tools, policy modules, tests, and current documentation. I did not treat older audit documents as proof that a behavior is currently fixed; I cross-checked them against the current source and test layout.

## Executive conclusion

The Voice system is not weak because it lacks engineering effort. It is weak because **too many responsibilities still converge inside one browser session controller**. The repository contains good safeguards—ephemeral token issuance, authenticated evidence verification, resumption handling, interruption support, and focused policy tests—but the implementation has a large coordination surface that makes behavior difficult to reason about and easy to regress.

The central architectural problem is that `frontend/js/voice/runtime.js` owns capture, resampling, provider transport, state transitions, lifecycle timers, tool orchestration, freshness gates, continuity reseeding, playback scheduling, diagnostics, and teardown. Its state object contains roughly **100 fields**, and the module is approximately **1,700 lines** long. This is a coordination monolith, even though several policy files have already been extracted. The extracted policies reduce local complexity but do not yet create a clear orchestration boundary.

The most important redesign is therefore not another prompt revision. MindPal needs an explicit **Voice Session Orchestrator** with typed events and isolated actors for capture, turn ownership, evidence, tools, playback, recovery, and persistence. Until that boundary exists, fixes will continue to land as flags and special cases inside `runtime.js`, which explains the feeling of an under-organized system.

## Current architecture map

| Area | Current location | Current responsibility | Assessment |
| --- | --- | --- | --- |
| UI integration | `frontend/js/voice_live.js` | Overlay, captions, lifecycle callbacks, post-call sync | Reasonable boundary, but callback-driven and dependent on runtime semantics |
| Session facade | `frontend/js/voice_session.js` | Public start/stop/state surface | Thin facade; most behavior remains below it |
| Main runtime | `frontend/js/voice/runtime.js` | Audio I/O, WebSocket, VAD, state, timers, tools, evidence, playback, reconnect, diagnostics | **Critical coordination monolith** |
| Conversation policy | `frontend/js/voice/conversation_policy.js` | Capture/lifecycle decisions and provider event reduction | Useful extraction, but still coupled to runtime state shape |
| Provider policy | `frontend/js/voice/provider_policy.js` | Capability and setup decisions | Good direction; needs a single provider adapter contract |
| Browser tools | `frontend/js/voice/tools.js` | Tool declarations, client execution, backend tool execution | Mixed trust boundary; browser and backend tools share one conceptual registry |
| Token/evidence API | `backend/api/voice_router.py` | Auth, rate limits, idempotency, quotas, token response, fact verification | Strong controls, but voice policy is split across frontend and backend |
| TTS | `backend/api/tts_router.py`, `backend/services/tts_service.py`, `backend/providers/camb_provider.py` | Non-Live speech synthesis | Separate from Live audio, but exposes a second voice architecture without a unified audio contract |

The repository’s own layered redesign document identifies five desired layers—capture/VAD, turn ownership, conversation policy, evidence/tools, and playback/continuity—but the current runtime still implements most of those layers in one module.[1]

## Findings

### 1. Critical: the runtime is a coordination monolith

`runtime.js` combines at least nine kinds of responsibility: raw PCM conversion and resampling; microphone graph creation; WebSocket construction and event handling; provider setup; VAD and turn completion; shared-idle calculation; current-fact gating; tool execution and background tasks; audio scheduling and interruption; reconnect/resumption; diagnostics; and teardown. The file’s state object also stores transport, audio nodes, policy flags, task maps, continuity, credentials, recovery counters, and UI callbacks together.[2]

This structure creates an implicit state machine rather than a single explicit one. The same session can be represented by `sessionPhase`, `isAiSpeaking`, `_inputTurnActive`, `_semanticUserTurnActive`, `awaitingModelResponseAt`, `_toolCallPending`, `_backgroundTasks`, fact-gate flags, reconnect flags, and playback-source collections. The result is that correctness depends on combinations of booleans and timestamps rather than on a small set of legal states.

**Impact:** regressions are likely to appear as cross-feature behavior: a silence prompt during playback, stale audio after a turn change, an evidence result released into the wrong turn, or a reconnect that preserves some state but not other state. These are exactly the types of defects described in the repository’s voice audit history.[1]

**Recommendation:** make the orchestrator the only component allowed to mutate session lifecycle. Replace boolean combinations with an event-driven state model and an immutable session snapshot. Keep audio nodes and provider transport behind adapters.

### 2. Critical: turn ownership is still distributed across unrelated mechanisms

The current design correctly attempts to distinguish raw microphone activity from provider-recognized user participation. However, that distinction is spread across `speechSeenRecently`, `_inputTurnActive`, `_semanticUserTurnActive`, `awaitingModelResponseAt`, playback-source count, tool state, evidence state, and session phase.[2] The `hasActiveConversationWork()` function derives a busy decision from these values, while separate functions and callbacks can independently change them.

This is a fragile form of distributed turn ownership. There is no durable `TurnContext` carrying a turn ID, user transcript, provider generation, tool tasks, evidence status, and playback generation as one unit. Without that identity, stale-result protection is implemented through scattered epochs and flags rather than through a simple rule: **a result may affect the UI or audio only if its turn and generation are still current**.

**Recommendation:** introduce `TurnContext` with `turnId`, `sessionGeneration`, `providerResponseId`, `status`, `topic`, `requiresEvidence`, and `playbackGeneration`. Every provider event, tool result, timer callback, and audio chunk must carry or resolve to this context.

### 3. High: there are two voice systems without a shared contract

MindPal has a native Live audio path and a separate Camb TTS path. The Live path streams PCM over a provider WebSocket, while Camb exposes `/tts-stream` and `/list-voices` through a provider abstraction.[3] The repository does not show a single normalized voice contract covering locale, voice identity, speaking rate, audio format, interruption semantics, queueing, latency metrics, and error taxonomy across both paths.

This increases product inconsistency. A user can experience one set of behaviors in Live Voice and another in fallback or synthesized responses, while developers must understand two different lifecycle and playback models. The Camb provider’s own documentation says voice listing is not yet used by the public TTS route, indicating that provider capability discovery is incomplete.[3]

**Recommendation:** define a `VoiceAudioProvider` interface with `connect`, `sendInput`, `receiveEvents`, `interrupt`, `close`, `synthesize`, and `capabilities`. Normalize provider events before they reach the orchestrator. Treat Live audio and TTS as implementations of the same contract, not as parallel feature silos.

### 4. High: tool trust boundaries are conceptually mixed

`frontend/js/voice/tools.js` contains tool declarations, client-side tool execution, and backend tool execution in one module.[2] The current design does gate volatile facts through an authenticated backend endpoint, which is a strong control. However, the model-facing declaration layer and the execution layer remain close enough that it is difficult to guarantee, by architecture, that every tool with external-data implications uses the verified backend path.

The backend verification route does correctly authenticate the request, apply tool and web-search rate limits, execute the registry’s `web_search`, reject empty results, and return an explicit verification failure.[4] The risk is not that this route is absent; the risk is that the frontend still has to decide when to invoke it and how to release the answer, while the provider can also generate ordinary tool calls in the Live session.

**Recommendation:** split tools into three registries: `LocalDeterministicTools`, `BackendVerifiedTools`, and `UnsupportedProviderTools`. The orchestrator, not the model, should enforce the evidence gate. A volatile-fact turn should be unable to transition to `playback-ready` until a backend evidence result is attached to the same `TurnContext`.

### 5. High: recovery and lifecycle complexity is concentrated in the same module as audio

The runtime stores separate counters and flags for reconnect attempts, resumption attempts, transient retries, recovery cycles, credential refresh, GoAway handling, reconnect timers, socket generation, session generation, and continuity reseeding.[2] Focused startup/recovery tests pass, including GoAway and rate-limit scenarios, which shows meaningful defensive work. However, these concerns remain embedded beside the audio graph and turn logic.

This makes recovery difficult to validate under combinations such as: user interruption during provider GoAway, background search completion during a socket replacement, playback queued while credential refresh is pending, or a stop action racing with reconnect scheduling.

**Recommendation:** extract a `TransportSupervisor` that owns socket generations, resumption handles, retry timing, and credential refresh. It should emit normalized events such as `transport.ready`, `transport.interrupted`, `transport.resumable`, `transport.failed`, and `transport.closed`. The session orchestrator should never call provider-specific recovery logic directly.

### 6. Medium: frontend tests validate policy helpers better than end-to-end behavior

The focused voice tests are healthy: the repository run reported **47 passing voice-related tests** in the targeted command, and the broader Node run reported **54 passing and 2 failing tests**. The two failures were not behavioral voice failures; they were import failures because `firebase` and `dompurify` were not installed in the checkout. The production build was also blocked because the `tailwindcss` executable was unavailable.[5]

The passing tests strongly cover pure policies: fact verification, prompt constraints, recovery timing, provider capability selection, local-time handling, inactivity logic, and summary state. They do not demonstrate a browser-level test of the complete chain from microphone frame to provider event to playback interruption and teardown. The repository’s documented validation scenarios require long speech, long model playback, interruption, stale-fact blocking, search failure, and crisis handling, but those scenarios are primarily described as acceptance criteria rather than as automated full-session tests.[1]

**Recommendation:** add a deterministic fake Live provider and fake AudioContext, then test complete event traces. Each trace should assert both emitted UI events and prohibited side effects, such as “no playback before evidence,” “no idle prompt during queued audio,” and “no stale response after interruption.”

### 7. Medium: observability records transport metadata but not a coherent turn trace

The runtime sends sanitized transport diagnostics containing model, close code, setup state, greeting state, and duration, explicitly excluding audio and transcript data.[2] This is privacy-conscious. It is not enough to explain conversation-quality failures, because the important causal sequence is at the turn level: who owned the turn, which provider event arrived, whether a timer fired, which tool was requested, whether evidence was pending, and which playback generation was active.

**Recommendation:** add privacy-safe correlation IDs and counters for session, turn, provider response, tool task, evidence gate, and playback generation. Record event names and timing only, with redacted lengths and status codes rather than content. This would make “why did it speak an old answer?” diagnosable without storing audio or personal text.

### 8. Medium: the architecture relies on a large amount of implicit provider behavior

The design depends on provider VAD, interruption semantics, multiple parts per server event, provider transcription, session resumption, and provider capability restrictions. The documentation correctly notes that unsupported features must not be claimed or configured.[1] The risk is that provider-specific assumptions are distributed across prompts, provider policy, runtime event handling, and tests instead of being isolated behind a versioned adapter.

**Recommendation:** add a provider contract test suite. For each supported provider/model, define the exact event shapes accepted, interruption behavior, supported tool scheduling, transcription guarantees, and resumption semantics. Fail startup when the configured model capability profile does not match the requested runtime features.

## What is already strong

The audit should not obscure the improvements already present. The current code uses authenticated ephemeral-token issuance rather than exposing a permanent provider key to the browser; it includes rate limiting, idempotency, quota reservation and refund behavior for transcription and summary endpoints; it sanitizes transport diagnostics; and it has a backend-only current-fact verification route that rejects empty search results.[4] The voice-specific Node tests also cover several previously fragile areas, including evidence gating, interruption policy, recovery, inactivity, and prompt restrictions.[5]

The weakness is therefore primarily **architectural cohesion and integration coverage**, not an absence of individual safeguards.

## Recommended target architecture

```text
Microphone / AudioContext
          |
          v
CaptureAdapter -----> ProviderAdapter <-----> Live/TTS provider
          |                  |
          v                  v
      VoiceEvent ------> SessionOrchestrator <------ ToolGateway
                              |
                +-------------+-------------+
                |             |             |
          TurnManager   EvidenceGate   PlaybackManager
                |             |             |
                +-------------+-------------+
                              |
                       UI / Transcript / Persistence
```

The orchestrator should consume normalized events and emit commands. `CaptureAdapter` should only produce audio and local signal metrics. `ProviderAdapter` should translate provider-specific WebSocket events into normalized events. `TurnManager` should own turn IDs and legal transitions. `EvidenceGate` should own freshness requirements and verified-result attachment. `ToolGateway` should separate local deterministic execution from authenticated backend execution. `PlaybackManager` should own audio queue generations and interruption clearing. Recovery should be a transport concern, not a turn-policy concern.

## Staged implementation plan

| Stage | Change | Exit criterion |
| --- | --- | --- |
| 0 | Add dependency installation and CI checks; make `npm test`, build, and Python tests reproducible from a clean checkout | Clean checkout can install and run all declared checks |
| 1 | Introduce normalized event types and `TurnContext`; keep existing runtime behavior behind an adapter | Every provider/tool/timer callback has a session and turn identity |
| 2 | Extract `PlaybackManager` and `CaptureAdapter` from `runtime.js` | Runtime no longer directly schedules individual audio sources or owns microphone graph details |
| 3 | Extract `TransportSupervisor` and provider adapters | Runtime no longer contains provider-specific socket/retry/resumption branches |
| 4 | Extract `EvidenceGate` and `ToolGateway` | Volatile-fact audio is impossible without an attached verified evidence result |
| 5 | Replace callback/boolean coordination with reducer-style transitions | Illegal transitions are rejected and observable |
| 6 | Add fake-provider full-session tests and browser/device validation | All documented validation scenarios pass with trace assertions |

## Priority order

The first implementation should be **turn identity plus playback ownership**, because stale and colliding work is the highest-risk class of conversational defects. The second should be transport isolation, because reconnect behavior currently shares a module with audio and turn state. The third should be tool/evidence ownership, because freshness must be an application guarantee rather than a model preference. Prompt refinement should come after those boundaries, not before them.

## Verification record

| Check | Result | Interpretation |
| --- | --- | --- |
| Targeted voice Node tests | Passed in the audit run | Policy-level safeguards are currently green |
| Full Node test command | 54 passed, 2 failed | Two failures were missing `firebase` and `dompurify` imports, not assertion failures |
| Frontend production build | Blocked | `tailwindcss` executable unavailable in the checkout environment |
| Python test command | Not runnable as invoked | `pytest` executable was unavailable; this is an environment/reproducibility gap, not evidence that Python tests pass or fail |
| Git working tree | Clean at audit start | Findings reflect repository state at commit `133ffc8` |

## Final assessment

MindPal’s Voice subsystem has a solid collection of recent fixes, but it still behaves like a **large callback-driven runtime with policy patches around it**, rather than a small, explicit voice platform. The feeling of weakness and disorder is consistent with that structure: the system has many controls, but no single authority for turn ownership, no unified provider contract, and no end-to-end traceable session model.

A successful redesign should reduce the number of mutable runtime flags, make every asynchronous result turn-scoped, isolate provider behavior, and test complete event traces. If those changes are made in the order above, later improvements to conversational style and latency will be easier to implement and much less likely to reintroduce the exact failures the project has already documented.

## References

[1]: ../../docs/voice_layered_redesign_audit.md "MindPal layered voice redesign audit"
[2]: ../../frontend/js/voice/runtime.js "MindPal voice runtime"
[3]: ../../backend/services/tts_service.py "MindPal TTS service"; ../../backend/providers/camb_provider.py "Camb provider adapter"
[4]: ../../backend/api/voice_router.py "MindPal voice API routes"
[5]: ../../tests/test_voice_startup_helpers.mjs "MindPal voice startup and runtime policy tests"; ../../tests/test_voice_security.py "MindPal voice security tests"; `package.json` "MindPal frontend scripts and dependencies"

*This assessment is an architecture review, not a claim that every documented historical defect remains present in the current build. Where the repository’s current execution environment prevented a check, that limitation is stated explicitly.*

> **Assumption:** “voice system” means the active native-audio Live path plus its token, tool, evidence, TTS, recovery, and persistence boundaries—not only the visual voice overlay.
