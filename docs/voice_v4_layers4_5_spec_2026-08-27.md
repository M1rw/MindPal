# Voice V4 Layers 4–5 — Playback and Session Ownership

**Status:** Layer 4 and Layer 5 implementation scope only. Production Voice remains inactive.

## Layer 4 responsibility

Layer 4 owns one browser `AudioContext`, one output gain path, one ordered PCM16 24 kHz queue, and the lifecycle of each `AudioBufferSourceNode`. It accepts only validated output chunks from Layer 2, converts them to mono `AudioBuffer` instances, and schedules each source against the AudioContext clock.

The queue exposes numeric snapshots only: queue duration, scheduled chunk count, active source count, drained chunk count, playback epoch, context state, and safe error code. It never logs, persists, or returns audio bytes.

A genuine drain requires `queuedDurationMs === 0` and `activeSourceCount === 0`. Provider generation completion and turn completion are not drain signals. Every source callback captures the epoch and is ignored if it belongs to a prior epoch.

An interruption increments the epoch, stops active sources, clears the queue, resets queue counters, and emits a fresh snapshot. A stale `ended` event cannot mark a later queue drained.

## Layer 5 responsibility

Layer 5 is the only owner allowed to coordinate token acquisition, one provider WebSocket, Layer 2 parsing, Layer 3 capture, Layer 4 playback, timers, and cleanup. It owns a monotonically increasing generation. Every callback, socket event, capture frame, playback callback, and timer must verify that generation before mutating state.

The baseline sequence is token request, one WebSocket open, one setup envelope, wait for one `setup_complete`, then start capture and forward validated frames. No frame is sent before setup completion. No reconnect is attempted in the baseline. On interruption, playback is flushed immediately. On stop or error, capture stops, playback closes/flushes, the socket closes, timers are cancelled, and the generation is invalidated.

Layer 5 does not infer speaking from received audio or transcripts. It emits a `playback_scheduled` fact only after Layer 4 accepts a chunk and emits a `playback_drained` fact only from Layer 4’s real drain callback.

## Boundary

These layers remain unimported by the active application until a later approval and Layer 6 integration. Tests use fake provider, capture, playback, and timer adapters. No real token, microphone recording, provider connection, transcript, or audio file is used in tests.

## References

1. [MDN — AudioBufferSourceNode.start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
2. [MDN — AudioScheduledSourceNode.ended event](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/ended_event)
3. [MDN — AudioScheduledSourceNode.stop()](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/stop)
4. [MDN — BaseAudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime)
