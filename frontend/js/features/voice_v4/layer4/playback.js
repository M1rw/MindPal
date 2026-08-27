import {
  VOICE_V4_OUTPUT_MIME_TYPE,
  validateOutputPcmChunk,
} from "../layer2/index.js";

const OUTPUT_SAMPLE_RATE_HZ = 24000;
const MIN_SCHEDULE_AHEAD_SECONDS = 0.01;
const MAX_CHUNK_BYTES = OUTPUT_SAMPLE_RATE_HZ * 2 * 5;

export const PLAYBACK_ERROR_CODES = Object.freeze({
  NOT_STARTED: "playback_not_started",
  CONTEXT_UNAVAILABLE: "playback_context_unavailable",
  INVALID_CHUNK: "playback_invalid_chunk",
  SCHEDULE_FAILED: "playback_schedule_failed",
  CLOSE_FAILED: "playback_close_failed",
  CALLBACK_FAILED: "playback_callback_failed",
});

export class VoicePlaybackError extends Error {
  constructor(code, message = "Voice playback is unavailable") {
    super(message);
    this.name = "VoicePlaybackError";
    this.code = code;
  }
}

export function createPlayback({
  AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext,
  onSnapshot = () => {},
  onError = () => {},
} = {}) {
  let context = null;
  let gainNode = null;
  let state = "IDLE";
  let epoch = 0;
  let nextStartTime = 0;
  let sequence = 0;
  let scheduledChunkCount = 0;
  let drainedChunkCount = 0;
  const activeSources = new Map();
  const drainListeners = new Set();
  let lastSnapshot = makeSnapshot();

  async function start() {
    if (state === "CLOSED") throw fail(PLAYBACK_ERROR_CODES.CONTEXT_UNAVAILABLE);
    if (state === "READY") return lastSnapshot;
    if (typeof AudioContextConstructor !== "function") throw fail(PLAYBACK_ERROR_CODES.CONTEXT_UNAVAILABLE);
    try {
      context = new AudioContextConstructor({ latencyHint: "interactive" });
      if (!context || typeof context.createBuffer !== "function" || typeof context.createBufferSource !== "function") {
        throw fail(PLAYBACK_ERROR_CODES.CONTEXT_UNAVAILABLE);
      }
      gainNode = context.createGain();
      gainNode.gain.value = 1;
      gainNode.connect(context.destination);
      if (typeof context.resume === "function") await context.resume();
      if (context.state === "closed") throw fail(PLAYBACK_ERROR_CODES.CONTEXT_UNAVAILABLE);
      state = "READY";
      return publish();
    } catch (error) {
      await closeContext();
      if (error instanceof VoicePlaybackError) throw error;
      throw fail(PLAYBACK_ERROR_CODES.CONTEXT_UNAVAILABLE);
    }
  }

  function schedulePcm24(bytes) {
    if (state !== "READY" || !context || !gainNode) throw fail(PLAYBACK_ERROR_CODES.NOT_STARTED);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
      throw fail(PLAYBACK_ERROR_CODES.INVALID_CHUNK);
    }
    let validated;
    try {
      validated = validateOutputPcmChunk(bytes);
    } catch (error) {
      throw fail(PLAYBACK_ERROR_CODES.INVALID_CHUNK);
    }

    try {
      const samples = decodePcm16LittleEndian(validated.bytes);
      const buffer = context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE_HZ);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);
      const sourceId = ++sequence;
      const sourceEpoch = epoch;
      const durationSeconds = samples.length / OUTPUT_SAMPLE_RATE_HZ;
      const startTime = Math.max(nextStartTime, context.currentTime + MIN_SCHEDULE_AHEAD_SECONDS);
      nextStartTime = startTime + durationSeconds;
      scheduledChunkCount += 1;
      activeSources.set(sourceId, { source, epoch: sourceEpoch });
      source.onended = () => handleEnded(sourceId, sourceEpoch);
      source.start(startTime);
      return publish();
    } catch (error) {
      throw fail(PLAYBACK_ERROR_CODES.SCHEDULE_FAILED);
    }
  }

  function flush(reason = "interrupted") {
    epoch += 1;
    for (const entry of activeSources.values()) {
      try {
        entry.source.stop();
      } catch (error) {
        onError({ code: PLAYBACK_ERROR_CODES.SCHEDULE_FAILED });
      }
    }
    activeSources.clear();
    nextStartTime = context?.currentTime || 0;
    scheduledChunkCount = 0;
    drainedChunkCount = 0;
    lastSnapshot = makeSnapshot({ lastAction: `flush_${safeReason(reason)}` });
    onSnapshot(lastSnapshot);
    return lastSnapshot;
  }

  async function close() {
    if (state === "CLOSED") return lastSnapshot;
    flush("close");
    state = "CLOSED";
    await closeContext();
    return publish();
  }

  function onDrain(listener) {
    if (typeof listener !== "function") throw new TypeError("drain listener must be a function");
    drainListeners.add(listener);
    return () => drainListeners.delete(listener);
  }

  function handleEnded(sourceId, sourceEpoch) {
    if (sourceEpoch !== epoch) return;
    if (!activeSources.delete(sourceId)) return;
    drainedChunkCount += 1;
    publish();
    if (isDrained()) notifyDrain();
  }

  function publish() {
    lastSnapshot = makeSnapshot();
    onSnapshot(lastSnapshot);
    return lastSnapshot;
  }

  function makeSnapshot(extra = {}) {
    const now = context?.currentTime || 0;
    const queueDepthMs = Math.max(0, (nextStartTime - now) * 1000);
    return Object.freeze({
      state,
      queueDepthMs: Math.round(queueDepthMs),
      scheduledChunkCount,
      drainedChunkCount,
      activeSourceCount: activeSources.size,
      audioContextState: context?.state || "uninitialized",
      playbackEpoch: epoch,
      errorCode: null,
      ...extra,
    });
  }

  function isDrained() {
    return activeSources.size === 0 && (!context || Math.max(0, nextStartTime - context.currentTime) === 0);
  }

  function notifyDrain() {
    for (const listener of drainListeners) {
      try {
        listener(lastSnapshot);
      } catch (error) {
        onError({ code: PLAYBACK_ERROR_CODES.CALLBACK_FAILED });
      }
    }
  }

  async function closeContext() {
    if (gainNode) {
      try {
        gainNode.disconnect();
      } catch (error) {
        onError({ code: PLAYBACK_ERROR_CODES.CLOSE_FAILED });
      }
    }
    if (context && typeof context.close === "function" && context.state !== "closed") {
      try {
        await context.close();
      } catch (error) {
        onError({ code: PLAYBACK_ERROR_CODES.CLOSE_FAILED });
      }
    }
    gainNode = null;
    context = null;
  }

  function fail(code) {
    onError({ code });
    return new VoicePlaybackError(code);
  }

  return Object.freeze({
    start,
    schedulePcm24,
    flush,
    close,
    onDrain,
    getSnapshot: () => lastSnapshot,
    getEpoch: () => epoch,
    outputMimeType: VOICE_V4_OUTPUT_MIME_TYPE,
  });
}

function decodePcm16LittleEndian(bytes) {
  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

function safeReason(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : "unknown";
}
