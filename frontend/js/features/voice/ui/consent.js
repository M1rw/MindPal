export const CONSENT_STATES = Object.freeze(["unknown", "granted", "declined"]);

export function createVoiceConsentController({
  initialState = "unknown",
  onChange = () => {},
} = {}) {
  let state = normalizeConsentState(initialState);

  function allow() {
    state = "granted";
    onChange(state);
    return state;
  }

  function decline() {
    state = "declined";
    onChange(state);
    return state;
  }

  function reset() {
    state = "unknown";
    onChange(state);
    return state;
  }

  return Object.freeze({
    allow,
    decline,
    reset,
    getState: () => state,
    hasGranted: () => state === "granted",
    hasDeclined: () => state === "declined",
  });
}

function normalizeConsentState(value) {
  return CONSENT_STATES.includes(value) ? value : "unknown";
}
