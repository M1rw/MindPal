// Deterministic product-level lifecycle policy for a Voice call.
// Provider socket renewal is an internal transport concern; this policy owns the
// user-visible call duration and inactivity contract.

export const VOICE_MAX_CALL_MS = 30 * 60 * 1_000;
export const VOICE_MAX_CALL_WARNING_MS = 28 * 60 * 1_000;
export const VOICE_USER_INACTIVITY_WARNING_MS = 2 * 60 * 1_000;
export const VOICE_USER_INACTIVITY_END_MS = 3 * 60 * 1_000;

export function getVoiceSessionLifecycleAction({
  now = Date.now(),
  sessionStartedAt = 0,
  lastUserActivityAt = 0,
  isBusy = false,
  sessionWarningSent = false,
  inactivityWarningSent = false,
} = {}) {
  const sessionElapsed = Math.max(0, Number(now) - Number(sessionStartedAt || now));
  const userInactiveFor = Math.max(0, Number(now) - Number(lastUserActivityAt || now));

  // The public maximum is a hard product boundary. It applies even when the
  // provider has transparently renewed its ten-minute transport connection.
  if (sessionElapsed >= VOICE_MAX_CALL_MS) return "session-end";
  if (sessionElapsed >= VOICE_MAX_CALL_WARNING_MS && !sessionWarningSent) return "session-warning";

  // Do not label a person inactive while MindPal is actively speaking, working,
  // reconnecting, or waiting for provider-owned turn completion.
  if (isBusy) return "none";
  if (userInactiveFor >= VOICE_USER_INACTIVITY_END_MS) return "inactive-end";
  if (userInactiveFor >= VOICE_USER_INACTIVITY_WARNING_MS && !inactivityWarningSent) return "inactive-warning";
  return "none";
}

export function getVoiceSessionLifecycleSnapshot({
  now = Date.now(),
  sessionStartedAt = 0,
  lastUserActivityAt = 0,
} = {}) {
  return {
    sessionElapsedMs: Math.max(0, Number(now) - Number(sessionStartedAt || now)),
    userInactiveForMs: Math.max(0, Number(now) - Number(lastUserActivityAt || now)),
    maxCallMs: VOICE_MAX_CALL_MS,
  };
}
