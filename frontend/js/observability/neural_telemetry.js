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

export function emitSafeModeRuntimeTrace(trace) {
  const safeTrace = normalizeRuntimeTrace(trace);
  if (!safeTrace) return;
  const event = { kind: "mindpal_safe_mode_trace", trace: safeTrace, timestamp: Date.now() };
  try { getChannel()?.postMessage(event); } catch { /* BroadcastChannel unavailable. */ }
  try { window.localStorage?.setItem("mindpal_safe_mode_last_trace_v1", JSON.stringify(event)); } catch { /* Optional local hand-off. */ }
}

export function readLastSafeModeRuntimeTrace() {
  try {
    const raw = window.localStorage?.getItem("mindpal_safe_mode_last_trace_v1");
    const value = raw ? JSON.parse(raw) : null;
    return value?.kind === "mindpal_safe_mode_trace" ? normalizeRuntimeTrace(value.trace) : null;
  } catch {
    return null;
  }
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

function normalizeRuntimeTrace(trace) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.events)) return null;
  const runId = String(trace.run_id || "").slice(0, 120);
  if (!runId) return null;
  const events = trace.events.slice(0, 64).map((event) => ({
    run_id: runId,
    sequence: Number(event.sequence || 0),
    timestamp_ms: Number(event.timestamp_ms || 0),
    kind: String(event.kind || "").slice(0, 40),
    node: String(event.node || "").slice(0, 40),
    status: String(event.status || "").slice(0, 24),
    duration_ms: Number.isFinite(Number(event.duration_ms)) ? Number(event.duration_ms) : null,
    parent: event.parent ? String(event.parent).slice(0, 40) : null,
    metadata: normalizeTraceMetadata(event.metadata),
  })).filter((event) => event.sequence > 0 && event.kind && event.node && event.status);
  return { run_id: runId, completed: Boolean(trace.completed), total_duration_ms: Number(trace.total_duration_ms || 0), events, metrics: normalizeTraceMetadata(trace.metrics) };
}

function normalizeTraceMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 16).filter(([key, item]) => /^[a-z_]{1,40}$/.test(key) && ["string", "number", "boolean"].includes(typeof item)).map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 80) : item]));
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
