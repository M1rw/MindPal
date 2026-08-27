import {
  buildRealtimeInputEnvelope,
  buildSetupEnvelope,
  createInitialSessionState,
  parseServerMessage,
  transitionSession,
} from "../layer2/index.js";
import { base64ToBytes, bytesToBase64 } from "./binary_codec.js";

const SOCKET_CLOSE_NORMAL = 1000;
const DEFAULT_VOICE_NAME = "Kore";
const MAX_INSTRUCTION_CHARS = 8_000;

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
      publish(transitionSession(state, { type: "socket_open", generation: activeGeneration }));
      socket = await socketFactory(grant.token, activeGeneration);
      if (!isCurrent(activeGeneration) || !socket || typeof socket.send !== "function") throw fail("socket_unavailable");
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
    await cleanupResources();
    state = createInitialSessionState(generation);
    publish(state);
    return state;
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
        applyFact({ type: "playback_scheduled", generation: activeGeneration, queueDepthMs: snapshot?.queueDepthMs });
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
    if (isCurrent(activeGeneration)) void failSession(new VoiceSessionError(error?.code || "capture_failed"), activeGeneration);
  }

  function handlePlaybackError(error, activeGeneration) {
    if (isCurrent(activeGeneration)) void failSession(new VoiceSessionError(error?.code || "playback_failed"), activeGeneration);
  }

  async function failSession(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    const sessionError = toSessionError(error, "session_failed");
    applyFact({ type: "provider_error", code: sessionError.code, generation: activeGeneration });
    stopped = true;
    generation += 1;
    cancelTimers();
    await cleanupResources();
    onError({ code: sessionError.code });
  }

  function applySafeStopFact(reason) {
    if (!state || state.state === "IDLE") return;
    const code = typeof reason === "string" && /^[a-z0-9_-]{1,40}$/i.test(reason) ? reason : "user_stop";
    publish(transitionSession(state, { type: "stop_requested", code, generation: state.generation }));
  }

  async function cleanupResources() {
    playbackUnsubscribe?.();
    playbackUnsubscribe = null;
    try { await capture?.stop?.(); } catch (error) { onError({ code: "capture_stop_failed" }); }
    try { await playback?.close?.(); } catch (error) { onError({ code: "playback_close_failed" }); }
    try { socket?.close?.(SOCKET_CLOSE_NORMAL, "session_end"); } catch (error) { onError({ code: "socket_close_failed" }); }
    capture = null;
    playback = null;
    socket = null;
    setupSent = false;
  }

  function cancelTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers = new Set();
  }

  function isCurrent(activeGeneration) {
    return !stopped && activeGeneration === generation;
  }

  function fail(code) {
    const error = new VoiceSessionError(code);
    onError({ code });
    return error;
  }

  return Object.freeze({
    start,
    stop,
    getState: () => state,
    getGeneration: () => generation,
    hasSetupSent: () => setupSent,
  });
}

function validTokenGrant(grant) {
  return Boolean(grant && typeof grant.token === "string" && grant.token.length > 0 && typeof grant.expires_at_utc === "string");
}

function normalizeInstruction(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_INSTRUCTION_CHARS) throw new VoiceSessionError("instruction_invalid");
  return value.trim();
}

function normalizeVoiceName(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value.trim())) throw new VoiceSessionError("voice_name_invalid");
  return value.trim();
}

function toSessionError(error, fallbackCode) {
  if (error instanceof VoiceSessionError) return error;
  return new VoiceSessionError(fallbackCode);
}
