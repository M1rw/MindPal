const STATUS_BY_STATE = Object.freeze({
  IDLE: "Ready for a voice conversation",
  REQUESTING_TOKEN: "Requesting a secure session",
  CONNECTING: "Connecting",
  SETUP_WAIT: "Waiting for provider setup",
  LISTENING: "Listening",
  USER_SPEAKING: "You are speaking",
  ASSISTANT_SPEAKING: "MindPal is speaking",
  INTERRUPTED: "Interrupted",
  RECONNECTING: "Reconnecting…",
  STOPPING: "Ending",
  ERROR: "Voice unavailable",
});

const ACTIVE_STATES = new Set([
  "REQUESTING_TOKEN",
  "CONNECTING",
  "SETUP_WAIT",
  "LISTENING",
  "USER_SPEAKING",
  "ASSISTANT_SPEAKING",
  "INTERRUPTED",
  "RECONNECTING",
  "STOPPING",
]);

const SPINNER_STATES = new Set([
  "REQUESTING_TOKEN",
  "CONNECTING",
  "SETUP_WAIT",
  "RECONNECTING",
]);

export function createVoiceViewModel({
  featureState,
  releaseDecision,
  sessionState,
  captureState,
  playbackSnapshot,
  consentState = "unknown",
  micLevel = null,    // { rmsDb: number, speaking: boolean } or null
  isMuted = false,
} = {}) {
  const enabled = featureState?.enabled === true && releaseDecision?.allowed === true;
  const state = normalizeSessionState(sessionState?.state);
  const playbackActive = Number(playbackSnapshot?.activeSourceCount) > 0;
  const truthfulSpeaking = state === "ASSISTANT_SPEAKING" && playbackActive;

  const status = !enabled
    ? "Voice unavailable"
    : state === "ASSISTANT_SPEAKING"
    ? truthfulSpeaking
      ? "MindPal is speaking"
      : "MindPal is generating"
    : STATUS_BY_STATE[state];

  const errorCode = sessionState?.errorCode || playbackSnapshot?.errorCode || null;

  // Mic level: clamp dBFS to a [0, 1] visual range for the orb animation.
  // Silence floor = -60 dBFS, full-scale = -6 dBFS (realistic peak talk level).
  const SILENCE_FLOOR_DB = -60;
  const PEAK_DB = -6;
  const rmsDb = typeof micLevel?.rmsDb === "number" ? micLevel.rmsDb : SILENCE_FLOOR_DB;
  const micLevelNorm = Math.max(0, Math.min(1, (rmsDb - SILENCE_FLOOR_DB) / (PEAK_DB - SILENCE_FLOOR_DB)));
  const micSpeaking = micLevel?.speaking === true;

  return Object.freeze({
    enabled,
    visible: enabled || state !== "IDLE",
    sessionState: state,
    captureState: normalizeCaptureState(captureState),
    consentState: normalizeConsentState(consentState),
    status,
    errorCode: normalizeErrorCode(errorCode),
    isActive: enabled && ACTIVE_STATES.has(state),
    isSpeaking: truthfulSpeaking,
    showSpinner: SPINNER_STATES.has(state),
    showConsent: enabled && consentState === "unknown" && state === "IDLE",
    showCaptions: true,
    canStart: enabled && consentState !== "declined" && ["IDLE", "ERROR"].includes(state),
    canStop: enabled && ACTIVE_STATES.has(state),
    isMuted,
    micLevelNorm,
    micLevelDb: rmsDb,
    micSpeaking,
  });
}

export function statusLabelForState(state) {
  return STATUS_BY_STATE[normalizeSessionState(state)];
}

function normalizeSessionState(value) {
  return Object.hasOwn(STATUS_BY_STATE, value) ? value : "ERROR";
}

function normalizeCaptureState(value) {
  return ["IDLE", "REQUESTING", "CAPTURING", "PAUSED", "STOPPED", "ERROR"].includes(value) ? value : "IDLE";
}

function normalizeConsentState(value) {
  return ["unknown", "granted", "declined"].includes(value) ? value : "unknown";
}

function normalizeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value) ? value : null;
}
