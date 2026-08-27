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
  let frameAccumulator = createFrameAccumulator({ frameSamples: CAPTURE_FRAME_SAMPLES });
  let stopped = false;

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
    const channels = extractChannels(event?.data);
    if (channels.length === 0 || !resampler) return;
    let frames;
    try {
      const mono = downmixToMono(channels);
      const resampled = resampler.push(mono);
      frames = frameAccumulator.push(resampled);
    } catch (error) {
      void failAndStop("capture_frame_invalid");
      return;
    }
    for (const frame of frames) {
      try {
        onFrame(encodeMonoPcm16LittleEndian(frame));
      } catch (error) {
        onError({ code: "frame_consumer_failed" });
      }
    }
  }

  async function resumeContext() {
    if (!audioContext || typeof audioContext.resume !== "function") return;
    await audioContext.resume();
    if (audioContext.state === "closed") throw fail(CAPTURE_ERROR_CODES.AUDIO_CONTEXT_UNAVAILABLE);
  }

  async function failAndStop(code) {
    setState("ERROR");
    onError({ code });
    stopped = true;
    await cleanupGraph();
  }

  function fail(code, message) {
    const error = new VoiceCaptureError(code || CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE, message);
    onError({ code: error.code });
    return error;
  }

  async function cleanupGraph() {
    if (workletNode?.port) workletNode.port.onmessage = null;
    disconnectNode(sourceNode, onError);
    disconnectNode(workletNode, onError);
    disconnectNode(muteSink, onError);
    stopTracks(stream);
    if (audioContext && typeof audioContext.close === "function" && audioContext.state !== "closed") {
      try {
        await audioContext.close();
      } catch (error) {
        onError({ code: "audio_context_close_failed" });
      }
    }
    stream = null;
    audioContext = null;
    sourceNode = null;
    workletNode = null;
    muteSink = null;
    resampler?.reset();
    resampler = null;
    frameAccumulator.reset();
  }

  function setTracksEnabled(enabled) {
    for (const track of stream?.getAudioTracks?.() || []) track.enabled = enabled;
  }

  return Object.freeze({
    start,
    pause,
    resume,
    stop,
    getState: () => state,
    getPendingSampleCount: () => frameAccumulator.pendingSampleCount(),
  });
}

function hasAudioTrack(stream) {
  return Boolean(stream && typeof stream.getAudioTracks === "function" && stream.getAudioTracks().length > 0);
}

function extractChannels(data) {
  if (data instanceof Float32Array) return [data];
  if (data?.samples instanceof Float32Array) return [data.samples];
  if (Array.isArray(data?.channels)) return data.channels;
  return [];
}

function disconnectNode(node, onError) {
  try {
    node?.disconnect?.();
  } catch (error) {
    onError({ code: "audio_disconnect_failed" });
  }
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop?.();
}
