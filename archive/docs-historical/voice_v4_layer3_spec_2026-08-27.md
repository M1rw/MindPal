# Voice V4 Layer 3 — Microphone Capture and Input Framing

**Status:** Layer 3 implementation scope only. This specification authorizes microphone capture code, but no provider WebSocket, playback, UI activation, dynamic prompt behavior, feelings model, deployment, or production enablement.

## Responsibility

Layer 3 owns browser microphone capability checks and the conversion of device audio into bounded mono PCM16 frames at the Layer 2 input contract of 16 kHz. It does not know about Firebase, Google, tokens, transcripts, prompts, playback, or session orchestration.

## Capability and permission contract

The capture boundary checks secure context, `navigator.mediaDevices.getUserMedia`, `AudioContext`, `audioWorklet.addModule`, and `AudioWorkletNode`. It requests audio only, with echo cancellation, noise suppression, and automatic gain control disabled where the browser accepts those preferences. Permission outcomes are normalized into stable codes: `insecure_context`, `media_devices_unavailable`, `audio_context_unavailable`, `audio_worklet_unavailable`, `permission_denied`, `device_not_found`, `device_unreadable`, `constraint_failed`, and `capture_unavailable`.

The request is made only by an explicit caller action in a later session/UI layer. Layer 3 exposes a function that can be called by that layer, but it does not invoke itself at import or startup.

## Signal path

The device sample rate is discovered from the actual `AudioContext.sampleRate`; it is not assumed to be 16 kHz. The AudioWorklet processor emits mono float samples to the main thread. A pure linear-interpolation resampler converts them to 16 kHz, then a PCM16 encoder clamps and rounds values into little-endian signed samples. A bounded frame accumulator emits exactly 320 samples per 20 ms frame at 16 kHz, retaining at most one partial frame between callbacks.

Before the later session layer opens its setup barrier, the capture owner may pause the source and must not accumulate an unbounded buffer. Layer 3 itself exposes `pause()` and `stop()`; stop disconnects nodes, stops every media track, closes the AudioContext, clears residual samples, and prevents late worklet messages from emitting frames.

## Privacy contract

PCM data exists only in memory long enough to form a frame and invoke the caller’s `onFrame` callback. Layer 3 never stores frames in local storage, IndexedDB, logs, diagnostics, reports, test fixtures, or network adapters. Tests use generated numeric samples and never write audio files.

## Exit criteria

Layer 3 is complete only when deterministic tests cover capability failures, permission mappings, mono conversion, resampling, PCM16 clipping/endian encoding, exact 20 ms framing, bounded partial buffers, pause, stop, processor-error handling, and late-message fencing. Static audits must show no provider, token, transcript, playback, or WebSocket logic in the Layer 3 module.

## References

1. [MDN — MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
2. [MDN — AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
3. [MDN — AudioContext() constructor](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext)
4. [MDN — BaseAudioContext.sampleRate](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/sampleRate)
