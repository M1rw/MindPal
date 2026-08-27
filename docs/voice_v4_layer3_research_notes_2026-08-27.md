# Voice V4 Layer 3 — Browser Research Notes

**Research date:** 27 August 2026

The implementation uses the browser’s `getUserMedia({ audio: ... })` only after an explicit user action. MDN documents that microphone access requires a secure context and user permission; missing or denied access can produce `NotAllowedError`, while unavailable devices can produce `NotFoundError`. The browser may also leave the permission promise pending when the user does not choose. These outcomes must map to bounded capability/permission states rather than infinite loading.

MDN documents that `AudioWorkletNode` runs a custom processor on the Web Audio rendering thread and that `BaseAudioContext.audioWorklet` is unavailable outside secure contexts. The processor must therefore be loaded only after secure-context and capability checks. A processor error produces silence for the node’s lifetime, so Layer 3 must surface a safe processor failure and stop rather than silently sending empty frames.

MDN documents that an `AudioContext` uses one sample rate for all nodes and that the default rate follows the output device. Layer 3 cannot assume the device runs at 16 kHz; it must explicitly resample the captured mono float samples to the 16 kHz PCM16 contract. The requested context latency should be interactive, but the implementation must inspect the actual context state and never claim capture success solely because construction succeeded.

## References

1. [MDN — MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
2. [MDN — AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
3. [MDN — AudioContext() constructor](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext)
4. [MDN — BaseAudioContext.sampleRate](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/sampleRate)
