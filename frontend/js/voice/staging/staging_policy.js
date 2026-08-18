const DEFAULTS = Object.freeze({
  minimumCueLatencyMs: 500,
  maximumCueDurationMs: 1_500,
  maximumProgressUpdates: 1,
});

const SUPPRESSED_GATES = new Set(["crisis", "medical"]);

export function classifyResponseStage({
  kind = "reasoning",
  expectedLatencyMs = 0,
  safetyGate = "none",
  alreadyAcknowledged = false,
  operationActive = true,
} = {}, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const latency = Math.max(0, Number(expectedLatencyMs) || 0);
  if (!operationActive) return { stage: "answer-now", reason: "operation-inactive" };
  if (alreadyAcknowledged) return { stage: "skip", reason: "already-acknowledged" };
  if (SUPPRESSED_GATES.has(safetyGate)) return { stage: "skip", reason: "safety-gate" };
  if (latency < config.minimumCueLatencyMs) return { stage: "answer-now", reason: "fast-operation" };
  return {
    stage: "thinking-cue",
    kind,
    maximumDurationMs: config.maximumCueDurationMs,
  };
}

export const STAGING_DEFAULTS = DEFAULTS;
