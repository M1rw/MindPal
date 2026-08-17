# MindPal Voice real-time continuity research

**Date:** 2026-08-17

## Provider facts that explain the ten-minute ending

Gemini Live limits a single WebSocket connection to roughly **ten minutes**, even when the logical session can be longer. The provider sends `GoAway` before it terminates the connection and exposes a `timeLeft` value. Session resumption is the documented mechanism for keeping one conversation active across those connection resets: retain the newest `SessionResumptionUpdate.newHandle`, reconnect, and place that handle in the next setup message. Resumption handles remain valid for two hours after the last session ends. [1] [2]

> A resumption update can be temporarily non-resumable while the model is generating or executing functions. In that state, its `newHandle` is empty and a resumed connection can lose the in-flight work. [2]

MindPal had session resumption enabled, but the GoAway handler was incomplete. It closed in 250 ms without respecting `timeLeft`, used one flag for both stale-response and GoAway reconnects, and ended the entire call whenever a subsequent close was marked normal. It also had no explicit fallback when no resumable handle was available. The browser log therefore reflects a real lifecycle defect—not user silence or microphone failure.

## Ephemeral-token result

An ephemeral token with `uses: 1` may still be reused for the mandatory ten-minute **session-resumption reconnect** during its `expireTime`; creating a second token is not necessary solely because the connection reset. By default, the connection can send messages for 30 minutes, while new sessions may only begin for one minute. [3]

Therefore, the right recovery order is: attempt resumption with the newest handle and the still-valid token; if a handle is unavailable or setup fails, provision a fresh token and open a new session with a bounded transcript continuity seed. It must never silently stop the user’s microphone/call after a GoAway.

## Real-time architecture implications

| Need | Verified active-model mechanism | MindPal design choice |
| --- | --- | --- |
| Fast human response after user yields | Continuous 16 kHz PCM input, automatic VAD, incremental processing, output at 24 kHz. [2] [4] | Reduce capture frames from 128 ms to 40 ms; keep audio streaming unbuffered; preserve automatic VAD and barge-in. |
| Natural interruption | `START_OF_ACTIVITY_INTERRUPTS`; provider returns `interrupted`, at which point playback must be discarded. [2] [4] | Keep user speech owner of the next turn; apply the existing 120 ms output fade before clearing queued audio. |
| Meaning-aware long turns | Input transcription is available but is independently delivered and unordered relative to audio/model events. [2] | Treat transcription as advisory incremental evidence, accumulate it in a turn ledger, and do not speak until VAD/turn completion. |
| Safe current facts | Function calling is supported, but Gemini 3.1 Live does not support provider non-blocking functions. [2] | Keep MindPal’s own verified backend tool lane and add a short post-yield Voice bridge while verified evidence is pending. |
| Long conversation | Context compression can extend audio sessions beyond the 15-minute context limit; resumption handles connection resets. [1] [4] | Retain sliding-window compression, add explicit GoAway state, and retain a compact local conversation ledger for an emergency fresh-session fallback. |
| Situation awareness | The provider supports VAD activity, transcriptions, generation completion, turn completion, interruptions, tool calls/cancellations, `GoAway`, and resumption events. [2] | Normalize these into internal interaction tags: `user-speaking`, `user-yielded`, `fact-verifying`, `tool-working`, `model-thinking`, `model-speaking`, `barge-in`, `resuming`, `continuity-reseeding`, and `shared-idle`. |

## Feature boundary: active Gemini 3.1 Flash Live Preview

The active model supports native audio, function calling, thinking levels, automatic/custom VAD, input/output transcription, session resumption, and context compression. It does not support provider-native asynchronous function calling, proactive audio, or affective dialogue. [2] MindPal should not imitate these unavailable capabilities through unreliable prompt tricks. Its advanced behavior should come from a clean application coordinator around the stable Live session.

## References

[1] [Google AI for Developers — Session management with Live API](https://ai.google.dev/gemini-api/docs/live-api/session-management)

[2] [Google AI for Developers — Live API WebSockets API reference](https://ai.google.dev/api/live)

[3] [Google AI for Developers — Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)

[4] [Google AI for Developers — Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)

## Next-layer architecture selected for MindPal

MindPal will not add another monolithic prompt or a simulated background voice. The application coordinator will maintain a small, explicit **interaction state** alongside the provider session.

| Coordinator state | Entry signal | User-visible behavior | Exit signal |
| --- | --- | --- | --- |
| `user-speaking` | Local activity and provider transcription | Quiet listening; no synthetic interruption. | Provider VAD yields / user turn completes. |
| `user-yielded` | VAD end plus held turn completion | Brief natural pause while MindPal identifies the response mode. | Model begins response, verified-tool bridge, or tool call. |
| `fact-verifying` | A deterministic volatile-fact classifier sees the transcript. | Status: “Checking that properly…”; after the original turn finishes, MindPal says one short spoken bridge before it waits. | Verified backend evidence or a transparent failure. |
| `tool-working` | Provider asks for a blocking tool. | Preserve listening state and show a concise tool status. | Matching tool response. |
| `model-thinking` / `model-speaking` | Provider generation/audio events. | Natural playback; VAD barge-in remains active. | `generationComplete` / queued audio drains / `turnComplete`. |
| `resuming` | Provider `GoAway`, a network close, or setup retry. | Status: “Keeping our conversation connected…”; microphone and call UI remain active. | New setup completes. |
| `continuity-reseeding` | No resumable handle or a bounded resume retry fails. | Status: “Restoring the thread…”; a compact trusted local call ledger seeds a fresh session. | New setup completes. |
| `shared-idle` | Neither party, no tools, no fact check, no recovery. | Only here may a delayed call check-in run. | Any interaction. |

### Fact-check bridge protocol

Voice never speaks a changing public fact until verified backend evidence is available. It should nevertheless sound present after the user yields. The coordinator therefore releases the original suppressed model turn, then sends a dedicated **internal bridge event** if verification is still pending. The Voice model is instructed to emit exactly one short, language-matched sentence such as: “Give me a second — I’m checking that properly.” It may not answer the fact, make a guess, or repeat the bridge. The evidence event then supersedes the bridge naturally when it arrives.

### Continuity protocol

When `GoAway` arrives, MindPal records the latest resumable handle, enters `resuming`, and schedules an explicit reconnect shortly before the provider’s `timeLeft` deadline. It treats the ensuing normal socket close as expected rather than a call-end signal. The first resumed setup receives the same ephemeral token and handle, as the provider documents. If the current handle is absent or the bounded resumption attempt cannot establish setup, MindPal provisions a new token and opens a fresh session seeded with a compact local ledger of the latest completed user/model turns. The microphone remains live throughout; only a final exhausted retry budget ends the call with a clear status.
