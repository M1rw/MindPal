# Voice v2 Production Trace Findings — 2026-08-19

Source: `/home/ubuntu/upload/pasted_content.txt` supplied by the user.

## Direct evidence

| Observation | Evidence | Consequence |
|---|---|---|
| Audio context is not the primary failure | `contextSampleRate: 24000`, `outputSampleRate: 24000`, `separateContext: true` | Playback is configured for the documented 24 kHz PCM path. |
| Automatic greeting is sent | `voice.auto-greeting-sent`, followed by AI caption `Hello! What's on your mind today?` | Provider setup and greeting request work. |
| Captions arrive before playback begins | AI captions `Hi there!`, then `playback.flushed/new-generation`, then first `playback.started`; later chunks also begin before/among playback events | Transcript delivery and caption release are not strictly coupled to actual audio start. |
| Audio chunks are extremely fragmented | Dozens of `playback.started` events within roughly 1.5 seconds, many separated by 0–30 ms | Each PCM chunk is treated as a separately visible playback start; diagnostics are noisy and caption timing can be unstable. |
| First long-turn cue is requested but never confirmed | `voice.backchannel.requested` followed by `voice.native-cue-timeout` | Cue request transport or response correlation is unreliable. |
| User speech interrupts after cue request | `backchannel.requested`, user caption, `playback.unducked`, `playback.flushed/provider-interrupted` | Cue request is competing with the active user turn and can trigger/receive interruption before delivery. |
| Some cues do work | `caption: Mmhmm`, `audioClass: backchannel`, then `voice.native-cue...delivered`; later `caption: Yeah?` | The provider can generate cues, but the request/response lifecycle is nondeterministic. |
| Main answer is misclassified as backchannel | After a cue request, output captions become `I don't`, `have`, `a name,`, `you can`, `just`, `refer`, `to me`, `as Gemini.` and every following playback event is `audioClass: backchannel` | The cue classification flag is leaking across the turn and incorrectly labels the real answer. |
| Cue timeout state leaks across later speech | A `native-cue-timeout` appears after later local speech starts | Pending cue requests are not reliably tied to a single response/turn and are not retired on all interruption paths. |
| User speech is detected locally | Local speech start/end events occur with RMS around 0.03–0.08 and thresholds around 0.022–0.033 | Local VAD is active and can drive diagnostics, but it must not create provider turns without transcript confirmation. |
| Browser performance is degraded | `requestAnimationFrame handler took 71ms` | UI animation/scroll or visualizer work may contribute to stutter during dense audio events. |

## Primary hypotheses to verify in code

1. `playback.started` is emitted once per PCM chunk rather than once per assistant audio turn. The caption scheduler uses these events as turn starts, so it may repeatedly reset or prematurely mark audio timing.
2. The orchestrator's `activeBackchannelResponse`/pending-backchannel classification is not scoped to a provider response identity and remains active after the cue is interrupted or after the cue's transcript is followed by a normal answer.
3. Native cue confirmation requires both cue audio and cue transcript, but the correlation currently picks the first pending request rather than matching provider response identity, so later audio/transcript can satisfy or time out the wrong request.
4. A realtime-text cue is sent while the user's current VAD turn is still active. If Gemini treats the realtime text as a competing input, it can cause an interruption or alter the next response turn. The request must be gated by confirmed input transcript/pause and explicitly correlated.
5. User input transcripts arriving after mute or from frames queued immediately before mute need a turn-generation/mute-epoch guard, not only a boolean check.
6. The output transcription stream may contain cumulative snapshots or partial chunks. Caption assembly needs separate source transcript state per provider response and must not let a cue caption become the source for the following answer.

## Required reproduction cases

- Greeting: output transcript before first PCM, then PCM in many small chunks.
- Normal answer after a cue: cue transcript and/or audio, user interruption, then a full answer; verify answer is `main`, not `backchannel`.
- Cue timeout: cue request with no matching cue output; then new user speech; verify no stale timeout or pending cue affects the new turn.
- Mute: press mute, inject a queued capture frame and a provider input transcript; verify neither reaches user transcript, caption, turn finalizer, or backchannel policy.
- Long story: sustained local speech plus provider partial transcript and a short pause; verify at most one cue, no answer suppression, and correct turn completion.
- Blob/ArrayBuffer: normalize provider messages delivered in each browser WebSocket payload form.

This file is an evidence record, not a claim that the hypotheses are already fixed.

## Initial assessment

The remaining production failures are primarily **turn ownership and event-correlation defects**, not a simple caption CSS defect. The trace proves that captions and audio both arrive, but cue audio is incorrectly allowed to influence the classification of subsequent main audio, and the cue timeout mechanism is not retiring cleanly. These must be fixed before further subjective audio tuning.

## Browser acceptance limitation

The user supplied this trace from the real browser. Any further microphone test requires explicit confirmation before using the connected browser. Local tests and live bundle checks alone cannot prove perceived full-duplex behavior.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Google Gemini Live API capabilities"
[2]: https://github.com/googleapis/js-genai/issues/1212 "Google GenAI output transcription issue discussion"

## Test-surface coverage measurement

Node’s built-in coverage run over all `tests/*.mjs` completed successfully, with overall coverage of 64.90% lines, 67.53% functions, and 67.09% branches. Voice-specific rows showed strong coverage for pure policy modules but significant gaps in integration-heavy code: `voice_session_v2.js` 28.88% lines / 30.19% functions, `browser_audio_adapter.js` 7.34% lines, `gemini_setup_builder.js` 11.39% lines, `voice_session_orchestrator.js` 74.44% lines / 62.50% functions, `playback_manager.js` 76.02% lines, and `gemini_live_adapter.js` 81.69% lines / 60.00% functions. This confirms that prior green tests did not constitute full functional coverage.

A deterministic fake-WebAudio integration test has now been added for browser capture worklet setup, frame forwarding, mute suppression, unmute, and disposal. A transport regression now covers `audioStreamEnd`. A cue-order regression covers transcript-before-audio ordering and interruption retirement. Backchannel policy coverage now asserts that zero-pause partial speech cannot request a cue.

## Confirmed changes in this audit pass

- Removed the global phrase-based backchannel audio classifier. Only an actually pending backchannel request can classify incoming PCM as a cue.
- Cancel pending backchannel manager state and native cue confirmations on provider interruption, turn completion, microphone mute, and session stop.
- Register native cue confirmation before sending realtime text, eliminating the request/response race that produced trace timeouts.
- Send the documented `realtimeInput.audioStreamEnd` payload when the microphone is muted.
- Emit `playback.started` only once per generation and audio class; subsequent PCM chunks emit `playback.chunk-scheduled`, reducing diagnostic/UI pressure.
- Flush cue audio on barge-in instead of preserving it over the user, matching Gemini’s interruption guidance.
- Require a minimum 180 ms pause before backchannel policy eligibility.
- Use `thinkingLevel: minimal` for Gemini 3.1 and `thinkingBudget: 0` only for Gemini 2.5.

## Validation after this pass

The focused Voice suite currently passes 36 tests after the fixes. Repository frontend and syntax audits also pass. Full build, complete JavaScript/Python suites, generated-asset verification, commit, deployment, and browser acceptance remain the final gates for this audit pass.
