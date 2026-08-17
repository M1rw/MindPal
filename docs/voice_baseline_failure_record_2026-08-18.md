# MindPal Voice baseline failure record

**Baseline commit:** `d0372a3`

**Recorded:** 2026-08-18

**Status:** Feature expansion frozen pending staged rebuild approval and gated implementation.

## User-observed production failures

| Evidence | Observed behavior | Severity |
| --- | --- | --- |
| Spoken local-time request: “Can you tell me what is the time right now?” | Voice routed the phrase `right now` to the volatile-fact gate and responded that it could not verify the time. | Critical correctness regression. |
| Voice status: “Verifying that now…” | The status changed, but MindPal did not speak the promised wait acknowledgement. | Critical interaction regression. |
| Browser console: `[Voice] Reconnect attempts exhausted.` | The call ended after its shared reconnect counter hit four attempts. | Critical continuity regression. |
| Desktop background noise | Single short RMS spikes opened the outgoing-audio gate and could barge in over model speech. | High interaction reliability regression. |

## Baseline code facts

The active runtime has one reconnect cap shared across provider GoAway resumption and ordinary transient network reconnects. Its `scheduleReconnect()` function stops the whole call when `MAX_RECONNECT_ATTEMPTS` is reached. A failed or expired resumption handle can therefore burn the same four attempts as a genuine network failure.

The time classifier currently uses deterministic routing, but the latest attempted bridge implementation sent internal post-yield messages through `clientContent`. The official Gemini 3.1 Flash Live capability guide states that `send_client_content` is only supported for **initial context history seeding** on this model; live text updates must use `send_realtime_input`. This mismatch is a credible explanation for the unsounded bridge and is a hard architecture blocker. [1]

## Provider facts verified against current official documentation

| Provider fact | Architecture consequence |
| --- | --- |
| Gemini 3.1 Flash Live is a preview native audio model with function calling, thinking, VAD, audio transcription, context compression, and session resumption. [1] [2] | The rebuild uses these primitives directly, with each capability assigned one owner. |
| A WebSocket connection lasts about 10 minutes; `GoAway` gives `timeLeft`; session resumption requires retaining the newest valid handle. [3] | GoAway resumption is an expected lifecycle event, not a generic retry and never a direct call-end condition. |
| Audio-only context is 15 minutes without compression; compression can extend logical sessions. [3] | Context compression remains mandatory for long calls, while resumption handles connection resets. |
| Gemini 3.1 supports automatic or custom VAD. Interruptions generate `interrupted`, and client playback queues should be cleared immediately. [1] [4] | One audio/turn coordinator owns VAD, barge-in, and playback state. Local audio measurements cannot independently end a semantic turn. |
| Gemini recommends 20–40 ms audio chunks and avoiding substantial client buffering. [4] | Audio capture and send timing become measurable phase-gated requirements, not hidden runtime heuristics. |
| Gemini 3.1 does not support provider-native asynchronous functions, proactive audio, or affective dialogue. [1] [2] | The rebuild will not emulate unavailable features with unsupported fields or fragile prompt tricks. |

## Freeze decision

No further changes will be deployed from this baseline until the phased architecture has been written and each layer has explicit acceptance criteria. The only permitted change before the architecture gate is a narrowly scoped stability restoration if an unsupported provider call prevents basic Voice operation.

## References

[1] [Gemini 3.1 Flash Live Preview model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)

[2] [Gemini Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

[3] [Session management with Live API](https://ai.google.dev/gemini-api/docs/live-api/session-management)

[4] [Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
