const CHANNEL_NAME = "mindpal-neural-observatory-v1";
const MAX_EVENTS = 48;
const STORAGE_KEY = "mindpal_neural_observatory_events_v1";

let channel = null;

function getChannel() {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

/**
 * Emits coarse, device-local visual telemetry for /brain. This is intentionally
 * not model instrumentation: no prompts, replies, account details, Firebase
 * credentials, memory records, or provider data are placed in the event.
 */
export function emitNeuralEvent(stage, details = {}) {
  const event = {
    kind: "mindpal_neural_stage",
    stage: normalizeStage(stage),
    timestamp: Date.now(),
    input_bucket: normalizeBucket(details.inputLength),
    duration_bucket: normalizeDuration(details.durationMs),
    source: "mindpal_client",
  };

  try { getChannel()?.postMessage(event); } catch { /* BroadcastChannel unavailable. */ }
  persistEvent(event);
}

export function readRecentNeuralEvents() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter(isSafeEvent).slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persistEvent(event) {
  try {
    const events = readRecentNeuralEvents();
    events.push(event);
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // The observatory remains useful through its idle visual mode if storage is unavailable.
  }
}

function normalizeStage(stage) {
  return new Set(["request", "tokenize", "attention", "activation", "sae", "feature_graph", "stream", "response", "error"]).has(stage) ? stage : "activation";
}

function normalizeBucket(value) {
  const length = Number(value || 0);
  if (!Number.isFinite(length) || length <= 0) return "unknown";
  if (length < 80) return "short";
  if (length < 320) return "medium";
  return "long";
}

function normalizeDuration(value) {
  const duration = Number(value || 0);
  if (!Number.isFinite(duration) || duration <= 0) return "unknown";
  if (duration < 1_000) return "fast";
  if (duration < 5_000) return "normal";
  return "extended";
}

function isSafeEvent(value) {
  return value && value.kind === "mindpal_neural_stage" && typeof value.stage === "string" && typeof value.timestamp === "number";
}
