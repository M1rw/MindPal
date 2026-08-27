const EVENTS = new Set([
  "session_created",
  "token_requested",
  "socket_open",
  "setup_sent",
  "setup_complete",
  "server_content",
  "input_transcription",
  "output_transcription",
  "generation_complete",
  "turn_complete",
  "interrupted",
  "playback_snapshot",
  "playback_drained",
  "go_away",
  "session_stopped",
  "error",
  "unknown",
]);

const STATES = new Set([
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

const AUDIO_CONTEXT_STATES = new Set(["suspended", "running", "closed", "interrupted", "unknown"]);
const MESSAGE_CATEGORIES = new Set([
  "setup_complete",
  "server_content",
  "tool_call",
  "tool_call_cancellation",
  "go_away",
  "session_resumption_update",
  "usage_metadata",
  "unknown",
]);

const FIELD_LIMITS = Object.freeze({
  generation: 2_000_000_000,
  playbackEpoch: 2_000_000_000,
  captureFrames: 10_000_000,
  sentFrames: 10_000_000,
  receivedAudioParts: 10_000_000,
  scheduledChunks: 10_000_000,
  drainedChunks: 10_000_000,
  queueDepthMs: 86_400_000,
  activeSources: 100_000,
});

const ALLOWED_FIELDS = new Set([
  "sessionId",
  "event",
  "state",
  "generation",
  "playbackEpoch",
  "audioContextState",
  "captureFrames",
  "sentFrames",
  "receivedAudioParts",
  "scheduledChunks",
  "drainedChunks",
  "queueDepthMs",
  "activeSources",
  "messageCategory",
  "errorCode",
]);

export function createSafeVoiceDiagnostic(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const diagnostic = {};

  if (isSafeSessionId(source.sessionId)) diagnostic.sessionId = source.sessionId;
  diagnostic.event = EVENTS.has(source.event) ? source.event : "unknown";
  if (STATES.has(source.state)) diagnostic.state = source.state;
  if (AUDIO_CONTEXT_STATES.has(source.audioContextState)) diagnostic.audioContextState = source.audioContextState;
  if (MESSAGE_CATEGORIES.has(source.messageCategory)) diagnostic.messageCategory = source.messageCategory;
  if (isSafeErrorCode(source.errorCode)) diagnostic.errorCode = source.errorCode;

  for (const [field, maximum] of Object.entries(FIELD_LIMITS)) {
    const value = boundedInteger(source[field], maximum);
    if (value !== null) diagnostic[field] = value;
  }

  return Object.freeze(diagnostic);
}

export function diagnosticFieldNames() {
  return Object.freeze([...ALLOWED_FIELDS]);
}

function isSafeSessionId(value) {
  return typeof value === "string" && /^vs_[A-Za-z0-9_-]{8,72}$/.test(value);
}

function isSafeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value);
}

function boundedInteger(value, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) return null;
  return value;
}
