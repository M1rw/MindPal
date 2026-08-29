export const VOICE_SESSION_STATES = Object.freeze([
  "IDLE",
  "REQUESTING_TOKEN",
  "CONNECTING",
  "SETUP_WAIT",
  "LISTENING",
  "USER_SPEAKING",
  "ASSISTANT_SPEAKING",
  "INTERRUPTED",
  "STOPPING",
  "ERROR",
]);

export const VOICE_V4_SESSION_STATES = VOICE_SESSION_STATES;

const STATE_SET = new Set(VOICE_SESSION_STATES);

export function createInitialSessionState(generation = 0) {
  return {
    state: "IDLE",
    generation: normalizeGeneration(generation),
    setupComplete: false,
    generationComplete: false,
    turnComplete: false,
    playbackScheduled: false,
    playbackDrained: true,
    goAway: false,
    lastErrorCode: null,
    lastTransition: "initial",
    ignoredStaleFacts: 0,
  };
}

export function beginSessionGeneration(generation) {
  return createInitialSessionState(generation);
}

export function transitionSession(current, fact) {
  const state = normalizeState(current);
  if (!fact || typeof fact !== "object" || typeof fact.type !== "string") {
    return transitionError(state, "malformed_fact");
  }

  if (fact.generation !== undefined && fact.generation !== state.generation) {
    return {
      ...state,
      ignoredStaleFacts: state.ignoredStaleFacts + 1,
      lastTransition: "stale_generation",
    };
  }

  switch (fact.type) {
    case "token_requested":
      return move(state, "REQUESTING_TOKEN", fact.type);
    case "socket_open":
      return move(state, "CONNECTING", fact.type);
    case "setup_sent":
      return move(state, "SETUP_WAIT", fact.type);
    case "setup_complete":
      return state.state === "SETUP_WAIT"
        ? move(state, "LISTENING", fact.type, { setupComplete: true })
        : transitionError(state, "setup_before_send");
    case "capture_activity":
      return requireSetup(state, fact.type, "USER_SPEAKING");
    case "playback_scheduled":
      return requireSetup(state, fact.type, "ASSISTANT_SPEAKING", {
        playbackScheduled: true,
        playbackDrained: false,
      });
    case "playback_drained":
      return move(state, state.setupComplete ? "LISTENING" : state.state, fact.type, {
        playbackDrained: true,
      });
    case "model_audio_part":
      return requireSetup(state, fact.type, state.state, { lastTransition: "audio_received" });
    case "input_transcript":
    case "output_transcript":
      return move(state, state.state, fact.type);
    case "generation_complete":
      return move(state, state.state, fact.type, { generationComplete: true });
    case "turn_complete":
      return move(state, state.state === "ASSISTANT_SPEAKING" ? state.state : "LISTENING", fact.type, {
        turnComplete: true,
      });
    case "interrupted":
      return requireSetup(state, fact.type, "INTERRUPTED", {
        generationComplete: false,
        turnComplete: false,
        playbackScheduled: false,
        playbackDrained: true,
      });
    case "go_away":
      return move(state, "STOPPING", fact.type, { goAway: true });
    case "provider_error":
      return transitionError(state, fact.code || "provider_error");
    case "stop_requested":
      return move(state, "STOPPING", fact.type);
    case "session_closed":
      return move(state, "IDLE", fact.type, {
        setupComplete: false,
        playbackScheduled: false,
        playbackDrained: true,
      });
    case "unknown_message":
      return move(state, state.state, fact.type);
    default:
      return transitionError(state, "unsupported_fact");
  }
}

function requireSetup(state, factType, nextState, updates = {}) {
  return state.setupComplete
    ? move(state, nextState, factType, updates)
    : transitionError(state, `${factType}_before_setup`);
}

function transitionError(state, code) {
  return {
    ...state,
    state: "ERROR",
    lastErrorCode: safeErrorCode(code),
    lastTransition: "error",
  };
}

function move(state, nextState, transitionName, updates = {}) {
  return {
    ...state,
    ...updates,
    state: STATE_SET.has(nextState) ? nextState : "ERROR",
    lastTransition: transitionName,
    lastErrorCode: nextState === "ERROR" ? state.lastErrorCode || "unknown_error" : null,
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") return createInitialSessionState(0);
  return {
    ...createInitialSessionState(state.generation),
    ...state,
    state: STATE_SET.has(state.state) ? state.state : "ERROR",
    generation: normalizeGeneration(state.generation),
  };
}

function normalizeGeneration(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value) ? value : "unknown_error";
}
