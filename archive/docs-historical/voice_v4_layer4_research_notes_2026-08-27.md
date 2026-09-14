# Voice V4 Layer 4 — Web Audio Research Notes

**Research date:** 27 August 2026

The playback design uses `AudioBufferSourceNode.start(when)` against the `AudioContext.currentTime` clock. MDN documents that `start()` schedules a source in the context time coordinate system and that a source can be started only once. Each PCM chunk therefore receives one source node and one scheduled start; the implementation must never reuse a source node.

The playback queue treats `ended` as a source-lifecycle fact, not as proof that the user heard output. MDN documents that the `ended` event fires when a scheduled source has stopped because its content or stop time completed. The queue still needs its own active-source and queued-duration accounting, and a later real drain condition must require both to be empty.

Interruption calls `stop()` on active sources where supported. MDN documents that `stop()` schedules immediate cessation when no time is supplied and that calls after a node has already stopped have no effect. The implementation therefore fences each source callback with a playback epoch so an old `ended` callback cannot drain or mutate a new queue.

The design reads `AudioContext.currentTime` for scheduling but does not expose it as a user-facing timing claim. MDN documents that the hardware timestamp can have reduced precision in some browsers, so the queue uses conservative scheduling and numeric diagnostics only.

## References

1. [MDN — AudioBufferSourceNode.start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
2. [MDN — AudioScheduledSourceNode.ended event](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/ended_event)
3. [MDN — AudioScheduledSourceNode.stop()](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/stop)
4. [MDN — BaseAudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime)
