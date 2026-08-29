import {
  CAPTURE_ERROR_CODES,
  buildMicrophoneConstraints,
  inspectCaptureCapabilities,
  mapCaptureError,
} from "./capabilities.js";
import {
  CAPTURE_FRAME_SAMPLES,
  createFrameAccumulator,
  createStreamingResampler,
  downmixToMono,
  encodeMonoPcm16LittleEndian,
} from "./signal_processing.js";
import { createVad } from "./vad.js";

export const CAPTURE_STATES = Object.freeze(["IDLE", "REQUESTING", "CAPTURING", "PAUSED", "STOPPED", "ERROR"]);
const PROCESSOR_NAME = "mindpal-v4-capture";

export class VoiceCaptureError extends Error {
  constructor(code, message = "Voice capture is unavailable") {
    super(message);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

export function createMicrophoneCapture({
  processorUrl,
  onFrame = () => {},
  onError = () => {},
  onStateChange = () => {},
  onLevel = () => {},        // { rmsDb: number, speaking: boolean } on every frame
  onSpeechStart = () => {},  // fires when VAD detects speech onset
  onSpeechEnd = () => {},    // fires when VAD detects speech end
  vadOptions = {},           // override VAD thresholds/holdoffs if needed
  secureContext = globalThis.isSecureContext,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeConstructor = globalThis.AudioWorkletNode,
} = {}) {
  let state = "IDLE";
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let workletNode = null;
  let muteSink = null;
  let resampler = null;
  let vad = null;
  let frameAccumulator = createFrameAccumulator({ frameSamples: CAPTURE_FRAME_SAMPLES });
  let stopped = false;
  let lastLevel = Object.freeze({ rmsDb: -96, speaking: false });

  function setState(nextState) {
    if (!CAPTURE_STATES.includes(nextState)) return;
    state = nextState;
    onStateChange(nextState);
  }

  async function start() {
    if (state === "CAPTURING" || state === "PAUSED") return;
    if (!processorUrl) throw fail(CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE, "AudioWorklet processor URL is required");

    const capabilities = inspectCaptureCapabilities({
      secureContext,
      mediaDevices,
      AudioContextConstructor,
      AudioWorkletNodeConstructor,
    });
    if (!capabilities.available) throw fail(capabilities.errorCode);

    stopped = false;
    setState("REQUESTING");
    try {
      stream = await mediaDevices.getUserMedia(buildMicrophoneConstraints());
      if (!hasAudioTrack(stream)) throw fail(CAPTURE_ERROR_CODES.DEVICE_NOT_FOUND);
      audioContext = new AudioContextConstructor({ latencyHint: "interactive" });
      if (!audioContext.audioWorklet || typeof audioContext.audioWorklet.addModule !== "function") {
        throw fail(CAPTURE_ERROR_CODES.AUDIO_WORKLET_UNAVAILABLE);
      }
      await audioContext.audioWorklet.addModule(processorUrl);
      resampler = createStreamingResampler(audioContext.sampleRate);
      vad = createVad({
        ...vadOptions,
        onSpeechStart: () => {
          if (!stopped && state === "CAPTURING") {
            try { onSpeechStart(); } catch {}
          }
        },
        onSpeechEnd: () => {
          if (!stopped && state === "CAPTURING") {
            try { onSpeechEnd(); } catch {}
          }
        },
        onLevel: (level) => {
          lastLevel = level;
          if (!stopped && state === "CAPTURING") {
            try { onLevel(level); } catch {}
          }
        },
      });
      frameAccumulator.reset();
      sourceNode = audioContext.createMediaStreamSource(stream);
      workletNode = new AudioWorkletNodeConstructor(audioContext, PROCESSOR_NAME);
      muteSink = audioContext.createGain();
      muteSink.gain.value = 0;
      workletNode.port.onmessage = handleWorkletMessage;
      workletNode.onprocessorerror = () => {
        void failAndStop(CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE);
      };
      sourceNode.connect(workletNode);
      workletNode.connect(muteSink);
      muteSink.connect(audioContext.destination);
      await resumeContext();
      setState("CAPTURING");
    } catch (error) {
      await cleanupGraph();
      if (error instanceof VoiceCaptureError) {
        setState("ERROR");
        throw error;
      }
      throw fail(mapCaptureError(error));
    }
  }

  async function pause() {
    if (state !== "CAPTURING") return;
    setTracksEnabled(false);
    // Notify VAD that we are silent (avoids stale speaking=true after unmute)
    vad?.reset();
    setState("PAUSED");
  }

  async function resume() {
    if (state !== "PAUSED") return;
    setTracksEnabled(true);
    await resumeContext();
    setState("CAPTURING");
  }

  async function stop() {
    if (state === "STOPPED" || state === "IDLE") {
      setState("STOPPED");
      return;
    }
    stopped = true;
    setState("STOPPED");
    await cleanupGraph();
  }

  function handleWorkletMessage(event) {
    if (stopped || state !== "CAPTURING") return;
    const channels = event?.data?.channels;
    if (!channels || !resampler) return;

    try {
      const mono = downmixToMono(channels);
      const resampled = resampler.push(mono);
      const frames = frameAccumulator.push(resampled);
      for (const frame of frames) {
        if (stopped || state !== "CAPTURING") break;
        // VAD runs on the 16 kHz mono frame (pre-encode, max accuracy)
        vad?.update(frame);
        onFrame(encodeMonoPcm16LittleEndian(frame));
      }
    } catch (error) {
      void failAndStop(CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE);
    }
  }

  async function failAndStop(code) {
    setState("ERROR");
    onError(new VoiceCaptureError(code));
    await stop();
  }

  function fail(code, message) {
    setState("ERROR");
    const error = new VoiceCaptureError(code, message);
    onError(error);
    return error;
  }

  async function resumeContext() {
    if (audioContext && audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  function setTracksEnabled(enabled) {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  async function cleanupGraph() {
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {}
      workletNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
      sourceNode = null;
    }
    if (muteSink) {
      try { muteSink.disconnect(); } catch {}
      muteSink = null;
    }
    if (stream) {
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch {}
      stream = null;
    }
    if (audioContext) {
      try {
        if (audioContext.state !== "closed") await audioContext.close();
      } catch {}
      audioContext = null;
    }
    resampler?.reset?.();
    frameAccumulator.reset();
    vad?.reset();
    vad = null;
  }

  return Object.freeze({
    start,
    pause,
    resume,
    stop,
    getState: () => state,
    getMicLevel: () => lastLevel,
  });
}

function hasAudioTrack(mediaStream) {
  return Boolean(mediaStream && typeof mediaStream.getAudioTracks === "function" && mediaStream.getAudioTracks().length > 0);
}
