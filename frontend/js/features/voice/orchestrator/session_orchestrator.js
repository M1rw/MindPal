import {
  buildActivityEndEnvelope,
  buildActivityStartEnvelope,
  buildRealtimeInputEnvelope,
  buildSetupEnvelope,
  createInitialSessionState,
  parseServerMessage,
  transitionSession,
} from "../protocol/index.js";
import { base64ToBytes, bytesToBase64 } from "./binary_codec.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SOCKET_CLOSE_NORMAL = 1000;
const DEFAULT_VOICE_NAME = "Kore";
const MAX_INSTRUCTION_CHARS = 8_000;
const SOCKET_OPEN_TIMEOUT_MS = 10_000;

// Exponential backoff schedule for reconnect attempts (ms).
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

// ─── Error type ───────────────────────────────────────────────────────────────

export class VoiceSessionError extends Error {
  constructor(code, message = "Voice session is unavailable") {
    super(message);
    this.name = "VoiceSessionError";
    this.code = code;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a full-duplex voice session with:
 * - Client-side VAD support (explicit activityStart/activityEnd signals)
 * - Automatic reconnect on unexpected socket close (up to MAX_RECONNECT_ATTEMPTS)
 * - Go-away pre-emptive reconnect before the server terminates the connection
 * - Session resumption handle forwarded to socketFactory on reconnect
 * - Mic mute / unmute (pause capture + send activityEnd / resume capture)
 */
export function createVoiceSession({
  tokenProvider,
  socketFactory,
  captureFactory,
  playbackFactory,
  instruction,
  voiceName = DEFAULT_VOICE_NAME,
  useClientVad = false,        // true → disable server VAD, send activity signals manually
  onStateChange = () => {},
  onFact = () => {},
  onTranscript = () => {},
  onError = () => {},
  onLevel = () => {},          // ({ rmsDb, speaking }) — forwarded from capture VAD
  encodeBase64 = bytesToBase64,
  decodeBase64 = base64ToBytes,
} = {}) {
  if (instruction !== undefined && (typeof instruction !== "string" || instruction.trim().length === 0)) {
    throw new VoiceSessionError("instruction_invalid", "instruction must be a non-empty string");
  }
  const safeInstruction = normalizeInstruction(instruction);
  const safeVoiceName = normalizeVoiceName(voiceName);

  // ── Session state ─────────────────────────────────────────────────────────
  let state = createInitialSessionState(0);
  let generation = 0;
  let socket = null;
  let capture = null;
  let playback = null;
  let playbackUnsubscribe = null;
  let stopped = true;
  let muted = false;

  // ── VAD state ─────────────────────────────────────────────────────────────
  let vadSpeaking = false;          // last known VAD state (avoids duplicate signals)

  // ── Session resumption ────────────────────────────────────────────────────
  let resumptionHandle = null;      // stored from last server sessionResumptionUpdate
  let goAwayReconnectTimer = null;  // scheduled reconnect before go-away deadline

  // ── Timer tracking ────────────────────────────────────────────────────────
  const timers = new Set();

  // ─── Internal helpers ────────────────────────────────────────────────────

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

  // ─── Session lifecycle ───────────────────────────────────────────────────

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
    muted = false;
    vadSpeaking = false;
    resumptionHandle = null;

    publish(transitionSession(state, { type: "token_requested", generation: activeGeneration }));
    try {
      await openSocket(activeGeneration, /* isReconnect */ false);
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
    cancelAllTimers();
    vadSpeaking = false;
    applySafeStopFact(reason);
    await cleanupResources("session_end");
    state = createInitialSessionState(generation);
    publish(state);
    return state;
  }

  // ─── Mute / unmute ───────────────────────────────────────────────────────

  async function mute() {
    if (muted || !capture) return;
    muted = true;
    await capture.pause();
    // If we were using client VAD and were speaking, signal end-of-speech
    if (useClientVad && vadSpeaking) {
      vadSpeaking = false;
      sendJson(buildActivityEndEnvelope());
    }
  }

  async function unmute() {
    if (!muted || !capture) return;
    muted = false;
    await capture.resume();
  }

  // ─── Socket management ───────────────────────────────────────────────────

  /**
   * Issue a token, open a socket, wait for it to be open, attach message
   * handlers, and send the setup envelope.
   */
  async function openSocket(activeGeneration, isReconnect) {
    const grant = await tokenProvider.issueToken();
    if (!isCurrent(activeGeneration) || !validTokenGrant(grant)) throw fail("token_invalid");

    // Pass the stored resumption handle to the socket factory so the server
    // can restore session context without a full round-trip.
    socket = await socketFactory(grant.token, activeGeneration, resumptionHandle ?? undefined);
    if (!isCurrent(activeGeneration) || !socket || typeof socket.send !== "function") throw fail("socket_unavailable");

    await waitForSocketOpen(socket, activeGeneration, SOCKET_OPEN_TIMEOUT_MS);
    if (!isCurrent(activeGeneration)) throw fail("session_stale");

    if (isReconnect) {
      applyFact({ type: "reconnect_success", generation: activeGeneration });
    } else {
      publish(transitionSession(state, { type: "socket_open", generation: activeGeneration }));
    }

    // Only create media resources on the initial connect
    if (!isReconnect) {
      capture = captureFactory({
        onFrame: (bytes) => handleCaptureFrame(bytes, activeGeneration),
        onError: (error) => handleCaptureError(error, activeGeneration),
        onSpeechStart: () => handleVadSpeechStart(activeGeneration),
        onSpeechEnd: () => handleVadSpeechEnd(activeGeneration),
        onLevel: (level) => {
          try { onLevel(level); } catch {}
        },
      });
      playback = playbackFactory({
        onError: (error) => handlePlaybackError(error, activeGeneration),
      });
      if (!capture || typeof capture.start !== "function" || !playback || typeof playback.start !== "function") {
        throw fail("media_factory_invalid");
      }
    }

    attachSocketHandlers(socket, activeGeneration);
    applyFact({ type: "setup_sent", generation: activeGeneration });
    socket.send(JSON.stringify(buildSetupEnvelope({
      instruction: safeInstruction,
      voiceName: safeVoiceName,
      useClientVad,
    })));
  }

  // ─── Reconnect logic ─────────────────────────────────────────────────────

  /**
   * Attempt to reconnect after a socket drop or go-away.
   * Uses exponential back-off; fails permanently after MAX_RECONNECT_ATTEMPTS.
   */
  async function scheduleReconnect(activeGeneration, attemptNumber) {
    if (!isCurrent(activeGeneration)) return;
    if (attemptNumber > MAX_RECONNECT_ATTEMPTS) {
      await failSession(new VoiceSessionError("reconnect_max_attempts"), activeGeneration);
      return;
    }

    applyFact({ type: "reconnect_scheduled", generation: activeGeneration });

    const delayMs = RECONNECT_DELAYS_MS[attemptNumber - 1] ?? RECONNECT_DELAYS_MS.at(-1);
    await sleep(delayMs, activeGeneration);
    if (!isCurrent(activeGeneration)) return;

    // Flush stale playback audio before reconnecting
    playback?.flush("reconnect");

    try {
      await openSocket(activeGeneration, /* isReconnect */ true);
      // setup_complete will flow through handleServerFact → startCapture
    } catch (error) {
      if (!isCurrent(activeGeneration)) return;
      // Retry on transient errors; surface permanent ones immediately
      const isTransient = ![
        "token_invalid",
        "voice_auth_required",
        "voice_preview_unavailable",
      ].includes(error?.code);
      if (isTransient) {
        void scheduleReconnect(activeGeneration, attemptNumber + 1);
      } else {
        await failSession(error, activeGeneration);
      }
    }
  }

  // ─── Socket handlers ─────────────────────────────────────────────────────

  function waitForSocketOpen(connection, activeGeneration, timeoutMs) {
    if (connection.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => settleReject(new VoiceSessionError("provider_socket_timeout")),
        timeoutMs
      );
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
      } catch {
        applyFact({ type: "provider_error", code: "malformed_provider_message", generation: activeGeneration });
        return;
      }
      for (const fact of parseServerMessage(message)) handleServerFact(fact, activeGeneration);
    };
    connection.onerror = () => {
      if (isCurrent(activeGeneration)) void failSession(new VoiceSessionError("provider_socket_error"), activeGeneration);
    };
    connection.onclose = (event) => {
      if (!isCurrent(activeGeneration) || stopped) return;
      // Normal close from stop() — don't reconnect
      if (event?.code === SOCKET_CLOSE_NORMAL) return;
      // Abnormal close → try to reconnect transparently
      const currentAttempt = (state.reconnectAttempt || 0) + 1;
      void scheduleReconnect(activeGeneration, currentAttempt);
    };
  }

  // ─── Server message handling ─────────────────────────────────────────────

  function handleServerFact(fact, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    const taggedFact = { ...fact, generation: activeGeneration };

    switch (fact.type) {
      case "setup_complete":
        applyFact(taggedFact);
        if (state.state === "LISTENING") void startCapture(activeGeneration);
        return;

      case "session_resumption_update":
        // Store the latest handle so the next reconnect can resume context
        if (fact.hasHandle) {
          // The raw handle arrives in the parsed fact; we stored it via parseServerMessage
          // which sets fact.resumptionHandle if present.
          if (typeof fact.resumptionHandle === "string") {
            resumptionHandle = fact.resumptionHandle;
          }
        }
        return;

      case "go_away":
        applyFact(taggedFact);
        scheduleGoAwayReconnect(activeGeneration, fact.timeLeftMs);
        return;

      case "provider_error":
        void failSession(new VoiceSessionError(fact.code || "provider_error"), activeGeneration);
        return;

      case "model_audio_part":
        try {
          const bytes = decodeBase64(fact.data);
          const snapshot = playback?.schedulePcm24(bytes);
          applyFact({
            type: "playback_scheduled",
            generation: activeGeneration,
            queueDepthMs: snapshot?.queueDepthMs,
            activeSourceCount: snapshot?.activeSourceCount,
          });
        } catch {
          void failSession(new VoiceSessionError("playback_schedule_failed"), activeGeneration);
        }
        return;

      case "interrupted":
        playback?.flush("provider_interrupted");
        applyFact(taggedFact);
        return;

      default:
        applyFact(taggedFact);
    }
  }

  function scheduleGoAwayReconnect(activeGeneration, timeLeftMs) {
    clearGoAwayTimer();
    // Reconnect 2 s before the server drops us; clamp to [0, timeLeftMs - 2000]
    const reconnectAfterMs = typeof timeLeftMs === "number" && timeLeftMs > 2500
      ? timeLeftMs - 2_000
      : 0;

    if (reconnectAfterMs === 0) {
      // Reconnect immediately
      void scheduleReconnect(activeGeneration, 1);
    } else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        goAwayReconnectTimer = null;
        void scheduleReconnect(activeGeneration, 1);
      }, reconnectAfterMs);
      timers.add(timer);
      goAwayReconnectTimer = timer;
    }
  }

  function clearGoAwayTimer() {
    if (goAwayReconnectTimer !== null) {
      clearTimeout(goAwayReconnectTimer);
      timers.delete(goAwayReconnectTimer);
      goAwayReconnectTimer = null;
    }
  }

  // ─── Media management ────────────────────────────────────────────────────

  async function startCapture(activeGeneration) {
    if (!isCurrent(activeGeneration) || !capture || !playback) return;
    try {
      await playback.start();
      playbackUnsubscribe = playback.onDrain?.(() => {
        if (isCurrent(activeGeneration) && !["INTERRUPTED", "STOPPING", "RECONNECTING", "ERROR"].includes(state.state)) {
          applyFact({ type: "playback_drained", generation: activeGeneration });
        }
      });
      if (!muted) await capture.start();
    } catch (error) {
      await failSession(error, activeGeneration);
    }
  }

  function handleCaptureFrame(bytes, activeGeneration) {
    if (!isCurrent(activeGeneration) || state.setupComplete !== true || state.state === "ERROR" || muted) return;
    sendJson(buildRealtimeInputEnvelope(encodeBase64(bytes)));
  }

  function handleVadSpeechStart(activeGeneration) {
    if (!isCurrent(activeGeneration) || !useClientVad || vadSpeaking) return;
    vadSpeaking = true;
    sendJson(buildActivityStartEnvelope());
    applyFact({ type: "capture_activity", generation: activeGeneration });
  }

  function handleVadSpeechEnd(activeGeneration) {
    if (!isCurrent(activeGeneration) || !useClientVad || !vadSpeaking) return;
    vadSpeaking = false;
    sendJson(buildActivityEndEnvelope());
  }

  function handleCaptureError(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    void failSession(error, activeGeneration);
  }

  function handlePlaybackError(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    void failSession(error, activeGeneration);
  }

  // ─── Failure / cleanup ───────────────────────────────────────────────────

  async function failSession(error, activeGeneration) {
    if (!isCurrent(activeGeneration)) return;
    const sessionError = toSessionError(error);
    stopped = true;
    generation += 1;
    cancelAllTimers();
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
    clearGoAwayTimer();
    if (capture) {
      try { await capture.stop(); } catch {}
      capture = null;
    }
    if (playback) {
      try { await playback.close(); } catch {}
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
    vadSpeaking = false;
    resumptionHandle = null;
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  function sendJson(envelope) {
    try {
      if (socket?.readyState === 1) socket.send(JSON.stringify(envelope));
    } catch {}
  }

  function cancelAllTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    goAwayReconnectTimer = null;
  }

  function fail(code, message) {
    const error = new VoiceSessionError(code, message);
    onError(error);
    return error;
  }

  function isCurrent(activeGeneration) {
    return activeGeneration === generation && !stopped;
  }

  /** Await a delay, but only if the session is still current. */
  function sleep(ms, activeGeneration) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return Object.freeze({
    start,
    stop,
    mute,
    unmute,
    isMuted: () => muted,
    getState: () => state,
    getGeneration: () => generation,
  });
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function toSessionError(error, fallbackCode = "voice_session_failed") {
  if (error instanceof VoiceSessionError) return error;
  const code = typeof error?.code === "string" ? error.code : fallbackCode;
  return new VoiceSessionError(code, error?.message);
}

function normalizeInstruction(instruction) {
  if (typeof instruction !== "string") return "You are MindPal. Respond naturally and concisely in audio.";
  return instruction.trim().slice(0, MAX_INSTRUCTION_CHARS);
}

function normalizeVoiceName(voiceName) {
  return typeof voiceName === "string" && voiceName.trim() ? voiceName.trim() : "Kore";
}

function validTokenGrant(grant) {
  return Boolean(grant && typeof grant.token === "string" && grant.token.length > 0);
}
