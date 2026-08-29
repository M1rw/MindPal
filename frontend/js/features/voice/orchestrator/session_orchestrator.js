import {
  buildRealtimeInputEnvelope,
  buildSetupEnvelope,
  createInitialSessionState,
  parseServerMessage,
  transitionSession,
} from "../protocol/index.js";
import { base64ToBytes, bytesToBase64 } from "./binary_codec.js";

const SOCKET_CLOSE_NORMAL = 1000;
const DEFAULT_VOICE_NAME = "Kore";
const MAX_INSTRUCTION_CHARS = 8_000;
const SOCKET_OPEN_TIMEOUT_MS = 10_000;

export class VoiceSessionError extends Error {
  constructor(code, message = "Voice session is unavailable") {
    super(message);
    this.name = "VoiceSessionError";
    this.code = code;
  }
}

export function createVoiceSession({
  tokenProvider,
  socketFactory,
  captureFactory,
  playbackFactory,
  instruction,
  voiceName = DEFAULT_VOICE_NAME,
  onStateChange = () => {},
  onFact = () => {},
  onTranscript = () => {},
  onError = () => {},
  encodeBase64 = bytesToBase64,
  decodeBase64 = base64ToBytes,
} = {}) {
  if (instruction !== undefined && (typeof instruction !== "string" || instruction.trim().length === 0)) {
    throw new VoiceSessionError("instruction_invalid", "instruction must be a non-empty string");
  }
  const safeInstruction = normalizeInstruction(instruction);
  const safeVoiceName = normalizeVoiceName(voiceName);
  let state = createInitialSessionState(0);
  let generation = 0;
  let socket = null;
  let capture = null;
  let playback = null;
  let playbackUnsubscribe = null;
  let stopped = true;
  let setupSent = false;
  let timers = new Set();

  function publish(nextState) {
    state = nextState;
    onStateChange(state);
    return state;
  }

  function applyFact(fact) {
    if (fact?.generation === undefined) fact = { ...fact, generation };
    if (fact.type === "input_transcript" || fact.type === "output_transcript") onTranscript(fact);
    onFact(fact);
    publish(transitionSession(state, fact));
    return state;
  }

  async function start() {
    if (!tokenProvider || typeof tokenProvider.issueToken !== "function") throw fail("token_provider_missing");
    if (typeof socketFactory !== "function") throw fail("socket_factory_missing");
    if (typeof captureFactory !== "function") throw fail("capture_factory_missing");
    if (typeof playbackFactory !== "function") throw fail("playback_factory_missing");
    if (!stopped) throw fail("session_already_active");

    generation += 1;
    const activeGeneration = generation;
    state = createInitialSessionState(activeGeneration);
    stopped = false;
    setupSent = false;
    publish(transitionSession(state, { type: "token_requested", generation: activeGeneration }));
    try {
      const grant = await tokenProvider.issueToken();
      if (!isCurrent(activeGeneration) || !validTokenGrant(grant)) throw fail("token_invalid");
      socket = await socketFactory(grant.token, activeGeneration);
      if (!isCurrent(activeGeneration) || !socket || typeof socket.send !== "function") throw fail("socket_unavailable");
      await waitForSocketOpen(socket, activeGeneration, SOCKET_OPEN_TIMEOUT_MS);
      if (!isCurrent(activeGeneration)) throw fail("session_stale");
      publish(transitionSession(state, { type: "socket_open", generation: activeGeneration }));
      capture = captureFactory({
        onFrame: (bytes) => handleCaptureFrame(bytes, activeGeneration),
        onError: (error) => handleCaptureError(error, activeGeneration),
      });
      playback = playbackFactory({
        onError: (error) => handlePlaybackError(error, activeGeneration),
      });
      if (!capture || typeof capture.start !== "function" || !playback || typeof playback.start !== "function") throw fail("media_factory_invalid");
      attachSocketHandlers(socket, activeGeneration);
      publish(transitionSession(state, { type: "setup_sent", generation: activeGeneration }));
      socket.send(JSON.stringify(buildSetupEnvelope({ instruction: safeInstruction, voiceName: safeVoiceName })));
      setupSent = true;
      return state;
    } catch (error) {
      await failSession(error, activeGeneration);
      throw toSessionError(error, "session_start_failed");
    }
  }

  async function stop(reason = "user_stop") {
    if (stopped) return state;
    stopped = true;
    generation += 1;
    cancelTimers();
    applySafeStopFact(reason);
    await cleanupResources("session_end");
    state = createInitialSessionState(generation);
    publish(state);
    return state;
  }

  function waitForSocketOpen(connection, activeGeneration, timeoutMs) {
    if (connection.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => settleReject(new VoiceSessionError("provider_socket_timeout")), timeoutMs);
      timers.add(timer);
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        timers.delete(timer);
        connection.onopen = null;
        connection.onerror = null;
        connection.onclose = null;
        callback();
      };
      const settleResolve = () => settle(resolve);
      const settleReject = (error) => settle(() => reject(error));
      connection.onopen = () => {
        if (isCurrent(activeGeneration)) settleResolve();
        else settleReject(new VoiceSessionError("session_stale"));
      };
      connection.onerror = () => settleReject(new VoiceSessionError("provider_socket_error"));
      connection.onclose = () => settleReject(new VoiceSessionError("provider_socket_closed"));
    });
  }

  function attachSocketHandlers(connection, activeGeneration) {
    connection.onmessage = (event) => {
      if (!isCurrent(activeGeneration)) return;
      let message;
      try {
        message = typeof event?.data === "string" ? JSON.parse(event.data) : event?.data;
      } catch (error) {
        applyFact({ type: "provider_error", code: "malformed_provider_message", generation: activeGeneration });
        return;
      }
      for (const fact of parseServerMessage(message)) handleServerFact(fact, activeGeneration);
    };
    connection.onerror = () => {
      if (isCurrent(activeGeneration)) void failSession(new VoiceSessionError("provider_socket_error"), activeGeneration);
    };
    connection.onclose = () => {
      if (isCurrent(activeGeneration) && !stopped) {
        void failSession(new VoiceSessionError("provider_socket_closed"), activeGeneration);
      }
    };
  }

  function handleServerFact(fact, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    const taggedFact = { ...fact, generation: activeGeneration };
    if (fact.type === "setup_complete") {
      applyFact(taggedFact);
      if (state.state === "LISTENING") void startCapture(activeGeneration);
      return;
    }
    if (fact.type === "provider_error") {
      void failSession(new VoiceSessionError(fact.code || "provider_error"), activeGeneration);
      return;
    }
    if (fact.type === "model_audio_part") {
      try {
        const bytes = decodeBase64(fact.data);
        const snapshot = playback?.schedulePcm24(bytes);
        applyFact({
          type: "playback_scheduled",
          generation: activeGeneration,
          queueDepthMs: snapshot?.queueDepthMs,
          activeSourceCount: snapshot?.activeSourceCount,
        });
      } catch (error) {
        void failSession(new VoiceSessionError("playback_schedule_failed"), activeGeneration);
      }
      return;
    }
    if (fact.type === "interrupted") {
      playback?.flush("provider_interrupted");
      applyFact(taggedFact);
      return;
    }
    applyFact(taggedFact);
  }

  async function startCapture(activeGeneration) {
    if (!isCurrent(activeGeneration) || !capture || !playback) return;
    try {
      await playback.start();
      playbackUnsubscribe = playback.onDrain?.(() => {
        if (isCurrent(activeGeneration) && !["INTERRUPTED", "STOPPING", "ERROR"].includes(state.state)) {
          applyFact({ type: "playback_drained", generation: activeGeneration });
        }
      });
      await capture.start();
    } catch (error) {
      await failSession(error, activeGeneration);
    }
  }

  function handleCaptureFrame(bytes, activeGeneration) {
    if (!isCurrent(activeGeneration) || state.setupComplete !== true || state.state === "ERROR") return;
    try {
      socket?.send(JSON.stringify(buildRealtimeInputEnvelope(encodeBase64(bytes))));
    } catch (error) {
      void failSession(new VoiceSessionError("audio_send_failed"), activeGeneration);
    }
  }

  function handleCaptureError(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    void failSession(error, activeGeneration);
  }

  function handlePlaybackError(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    void failSession(error, activeGeneration);
  }

  async function failSession(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    const sessionError = toSessionError(error);
    stopped = true;
    generation += 1;
    cancelTimers();
    applyFact({ type: "provider_error", code: sessionError.code, generation: activeGeneration });
    onError(sessionError);
    await cleanupResources("error");
  }

  function applySafeStopFact(reason) {
    applyFact({ type: "stop_requested", reason, generation });
    applyFact({ type: "session_closed", generation });
  }

  async function cleanupResources(closeReason = "session_end") {
    playbackUnsubscribe?.();
    playbackUnsubscribe = null;
    if (capture) {
      try {
        await capture.stop();
      } catch {}
      capture = null;
    }
    if (playback) {
      try {
        await playback.close();
      } catch {}
      playback = null;
    }
    if (socket) {
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(SOCKET_CLOSE_NORMAL, closeReason);
        }
      } catch {}
      socket = null;
    }
  }

  function cancelTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function fail(code, message) {
    const error = new VoiceSessionError(code, message);
    onError(error);
    return error;
  }

  function isCurrent(activeGeneration) {
    return activeGeneration === generation && !stopped;
  }

  return Object.freeze({
    start,
    stop,
    getState: () => state,
    getGeneration: () => generation,
  });
}

function toSessionError(error, fallbackCode = "voice_session_failed") {
  if (error instanceof VoiceSessionError) return error;
  const code = typeof error?.code === "string" ? error.code : fallbackCode;
  return new VoiceSessionError(code, error?.message);
}

function normalizeInstruction(instruction) {
  if (typeof instruction !== "string") return "You are MindPal. Respond naturally and concisely in audio.";
  const text = instruction.trim();
  return text.slice(0, MAX_INSTRUCTION_CHARS);
}

function normalizeVoiceName(voiceName) {
  return typeof voiceName === "string" && voiceName.trim() ? voiceName.trim() : DEFAULT_VOICE_NAME;
}

function validTokenGrant(grant) {
  return Boolean(grant && typeof grant.token === "string" && grant.token.length > 0);
}
