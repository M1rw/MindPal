const CONSENT_STATES = Object.freeze(["unknown", "granted", "declined"]);

export function createVoiceConsentController({ onChange = () => {} } = {}) {
  let state = "unknown";

  function setState(nextState) {
    if (!CONSENT_STATES.includes(nextState)) return state;
    state = nextState;
    onChange(state);
    return state;
  }

  return Object.freeze({
    allow: () => setState("granted"),
    decline: () => setState("declined"),
    reset: () => setState("unknown"),
    getState: () => state,
    isGranted: () => state === "granted",
  });
}
