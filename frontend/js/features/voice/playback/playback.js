import {
  VOICE_OUTPUT_MIME_TYPE,
  validateOutputPcmChunk,
} from "../protocol/index.js";

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

  function flush(reason = "user_flush") {
    epoch += 1;
    nextStartTime = context?.currentTime || 0;
    for (const [id, entry] of activeSources.entries()) {
      try {
        entry.source.stop();
        entry.source.disconnect();
      } catch {}
      activeSources.delete(id);
    }
    publish();
    return makeSnapshot();
  }

  async function close() {
    if (state === "CLOSED") return;
    state = "CLOSED";
    flush("closing");
    await closeContext();
  }

  function onDrain(listener) {
    if (typeof listener !== "function") return () => {};
    drainListeners.add(listener);
    return () => drainListeners.delete(listener);
  }

  function handleEnded(sourceId, sourceEpoch) {
    if (sourceEpoch !== epoch) return;
    const entry = activeSources.get(sourceId);
    if (!entry) return;
    try {
      entry.source.disconnect();
    } catch {}
    activeSources.delete(sourceId);
    drainedChunkCount += 1;
    publish();
    if (activeSources.size === 0) notifyDrain();
  }

  function notifyDrain() {
    for (const listener of drainListeners) {
      try {
        listener(makeSnapshot());
      } catch (error) {
        onError(new VoicePlaybackError(PLAYBACK_ERROR_CODES.CALLBACK_FAILED));
      }
    }
  }

  function publish() {
    lastSnapshot = makeSnapshot();
    onSnapshot(lastSnapshot);
    return lastSnapshot;
  }

  function makeSnapshot() {
    const queueDepthSeconds = context && nextStartTime > context.currentTime ? Math.max(0, nextStartTime - context.currentTime) : 0;
    return Object.freeze({
      state,
      epoch,
      playbackEpoch: epoch,
      activeSourceCount: activeSources.size,
      scheduledChunkCount,
      drainedChunkCount,
      queueDepthMs: Math.round(queueDepthSeconds * 1000),
      currentTimeSeconds: context?.currentTime || 0,
      audioContextState: context?.state || "unknown",
      outputMimeType: VOICE_OUTPUT_MIME_TYPE,
    });
  }

  function fail(code, message) {
    const error = new VoicePlaybackError(code, message);
    onError(error);
    return error;
  }

  async function closeContext() {
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {}
    }
    context = null;
    gainNode = null;
  }

  return Object.freeze({
    start,
    schedulePcm24,
    flush,
    close,
    onDrain,
    getEpoch: () => epoch,
    getSnapshot: () => lastSnapshot,
  });
}

function decodePcm16LittleEndian(bytes) {
  const sampleCount = bytes.byteLength / 2;
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    const int16 = view.getInt16(index * 2, true);
    samples[index] = int16 < 0 ? int16 / 32768 : int16 / 32767;
  }
  return samples;
}
