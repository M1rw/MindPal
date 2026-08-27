const STATUS_BY_STATE = Object.freeze({
  IDLE: "Ready for a voice conversation",
  REQUESTING_TOKEN: "Requesting a secure session",
  CONNECTING: "Connecting",
  SETUP_WAIT: "Waiting for provider setup",
  LISTENING: "Listening",
  USER_SPEAKING: "You are speaking",
  ASSISTANT_SPEAKING: "MindPal is speaking",
  INTERRUPTED: "Interrupted",
  STOPPING: "Ending",
  ERROR: "Voice unavailable",
});

const ACTIVE_STATES = new Set(["REQUESTING_TOKEN", "CONNECTING", "SETUP_WAIT", "LISTENING", "USER_SPEAKING", "ASSISTANT_SPEAKING", "INTERRUPTED", "STOPPING"]);

export function createVoiceViewModel({
  featureState,
  releaseDecision,
  sessionState,
  captureState,
  playbackSnapshot,
  consentState = "unknown",
} = {}) {
  const enabled = featureState?.enabled === true && releaseDecision?.allowed === true;
  const state = normalizeSessionState(sessionState?.state);
  const playbackActive = Number(playbackSnapshot?.activeSourceCount) > 0;
  const truthfulSpeaking = state === "ASSISTANT_SPEAKING" && playbackActive;
  const status = !enabled ? "Voice unavailable" : state === "ASSISTANT_SPEAKING" ? (truthfulSpeaking ? "MindPal is speaking" : "MindPal is generating") : STATUS_BY_STATE[state];
  const errorCode = sessionState?.errorCode || playbackSnapshot?.errorCode || null;

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
    showConsent: enabled && consentState === "unknown" && state === "IDLE",
    showCaptions: true,
    canStart: enabled && consentState !== "declined" && ["IDLE", "ERROR"].includes(state),
    canStop: enabled && ACTIVE_STATES.has(state),
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
