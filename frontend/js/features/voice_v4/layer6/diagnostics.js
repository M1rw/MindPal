import { createSafeVoiceDiagnostic } from "../layer0/diagnostics.js";

const COUNTER_FIELDS = Object.freeze([
  "generation",
  "playbackEpoch",
  "captureFrames",
  "sentFrames",
  "receivedAudioParts",
  "scheduledChunks",
  "drainedChunks",
  "queueDepthMs",
  "activeSources",
]);

export function createVoiceDiagnostics({ sessionId = null } = {}) {
  let current = createSafeVoiceDiagnostic({ sessionId, event: "session_created", state: "IDLE" });

  function record(payload = {}) {
    const next = createSafeVoiceDiagnostic({ ...payload, sessionId: payload.sessionId || current.sessionId || sessionId });
    current = mergeDiagnostic(current, next);
    return current;
  }

  function reset(nextSessionId = null) {
    current = createSafeVoiceDiagnostic({ sessionId: nextSessionId, event: "session_created", state: "IDLE" });
    return current;
  }

  return Object.freeze({
    record,
    reset,
    getSnapshot: () => ({ ...current }),
  });
}

function mergeDiagnostic(previous, next) {
  const merged = { ...previous, ...next };
  for (const field of COUNTER_FIELDS) {
    if (Number.isInteger(previous[field]) && Number.isInteger(next[field])) merged[field] = Math.max(previous[field], next[field]);
  }
  return createSafeVoiceDiagnostic(merged);
}
