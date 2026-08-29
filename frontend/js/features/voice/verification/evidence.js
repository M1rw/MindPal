import { createSafeVoiceDiagnostic } from "../contracts/diagnostics.js";

const GATES = new Set(["A", "B", "C", "D", "E", "F"]);
const SAFE_EVENTS = new Set(["gate_started", "evidence_recorded", "gate_passed", "gate_failed", "run_stopped"]);
const SAFE_BOOLEAN_FIELDS = new Set([
  "secureContext", "microphonePermission", "audioWorklet", "audioContext", "captureGraph",
  "authenticatedRequest", "constrainedToken", "shortLivedToken", "browserSecretScanClean",
  "socketOpened", "setupSentOnce", "setupComplete", "audioBeforeSetupZero",
  "realMicrophoneSpeech", "captureFramesProduced", "framesSentAfterSetup", "providerInputTranscription", "relevantResponseObserved",
  "providerAudioReceived", "audioDecoded", "audioScheduled", "audioDrained", "humanAudibilityConfirmed",
  "speechDuringAudibleOutput", "interruptionObserved", "playbackFlushed", "nextTurnWorks", "cleanupObserved",
]);
const SAFE_INTEGER_FIELDS = new Set([
  "captureFrames", "sentFrames", "receivedAudioParts", "scheduledChunks", "drainedChunks", "queueDepthMs", "activeSources", "generation", "playbackEpoch",
]);

export function createLayer7EvidenceCollector({ runId, clock = () => 0 } = {}) {
  const safeRunId = normalizeRunId(runId);
  const entries = [];

  function record({ gate, event = "evidence_recorded", state, facts = {} } = {}) {
    if (!GATES.has(gate)) throw new Error("unknown_gate");
    if (!SAFE_EVENTS.has(event)) throw new Error("unsafe_evidence_event");
    const safeFacts = sanitizeFacts(facts);
    const safeDiagnostic = createSafeVoiceDiagnostic({ sessionId: safeRunId, event, state, ...safeFacts });
    const entry = Object.freeze({
      runId: safeRunId,
      gate,
      event,
      at: boundedTime(clock()),
      ...safeDiagnostic,
      ...safeFacts,
    });
    entries.push(entry);
    return entry;
  }

  function snapshot() {
    return Object.freeze({ runId: safeRunId, entries: Object.freeze([...entries]) });
  }

  return Object.freeze({ record, snapshot });
}

export function sanitizeLayer7Evidence(facts = {}) {
  return sanitizeFacts(facts);
}

function sanitizeFacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("facts_must_be_object");
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_BOOLEAN_FIELDS.has(key) && typeof entry === "boolean") safe[key] = entry;
    if (SAFE_INTEGER_FIELDS.has(key) && Number.isInteger(entry) && entry >= 0 && entry <= 10_000_000) safe[key] = entry;
  }
  return Object.freeze(safe);
}

function normalizeRunId(value) {
  if (typeof value !== "string" || !/^vr_[A-Za-z0-9_-]{8,72}$/.test(value)) throw new TypeError("invalid_run_id");
  return value;
}

function boundedTime(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 9_007_199_254_740_991) : 0;
}
