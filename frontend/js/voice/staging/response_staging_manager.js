import { classifyResponseStage } from "./staging_policy.js";

const CUE_INTENTS = Object.freeze({
  reasoning: "thinking",
  "current-fact": "checking",
  memory: "remembering",
  calculation: "calculating",
  research: "checking-details",
  "safety-careful": "careful-response",
  reconnect: "continuity",
});

export function createResponseStagingManager({
  onRequest = () => {},
  onCancel = () => {},
  now = () => Date.now(),
  policyOptions = {},
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const operations = new Map();

  function start(request = {}) {
    if (!request.operationId || !request.turnId) {
      return Object.freeze({ stage: "skip", reason: "missing-identity" });
    }
    const decision = classifyResponseStage(request, policyOptions);
    const operation = Object.freeze({
      ...request,
      cueIntent: CUE_INTENTS[request.kind] || "thinking",
      startedAt: now(),
      cueRequested: decision.stage === "thinking-cue",
      cueEmitted: false,
      cancelled: false,
    });
    operations.set(request.operationId, operation);
    if (decision.stage === "thinking-cue") {
      const delay = Math.max(0, Number(policyOptions.minimumCueLatencyMs ?? 500) || 0);
      const timer = setTimeoutImpl?.(() => {
        const current = operations.get(request.operationId);
        if (current && !current.cancelled && !current.cueEmitted) onRequest(current);
      }, delay);
      operations.set(request.operationId, Object.freeze({ ...operation, cueTimer: timer }));
    }
    return Object.freeze({ ...decision, operation });
  }

  function markCueEmitted(operationId) {
    const operation = operations.get(operationId);
    if (!operation || operation.cancelled || !operation.cueRequested) return false;
    if (operation.cueTimer != null) clearTimeoutImpl?.(operation.cueTimer);
    operations.set(operationId, Object.freeze({ ...operation, cueEmitted: true, cueTimer: null }));
    return true;
  }

  function complete(operationId, result = {}) {
    const operation = operations.get(operationId);
    if (!operation) return false;
    if (operation.cueTimer != null) clearTimeoutImpl?.(operation.cueTimer);
    operations.delete(operationId);
    return Object.freeze({ operation, result, completedAt: now() });
  }

  function cancel(operationId, reason = "cancelled") {
    const operation = operations.get(operationId);
    if (!operation) return false;
    if (operation.cueTimer != null) clearTimeoutImpl?.(operation.cueTimer);
    operations.delete(operationId);
    const cancelled = Object.freeze({ ...operation, cancelled: true, reason, cancelledAt: now() });
    onCancel(cancelled);
    return true;
  }

  function cancelForTurn(turnId, reason = "turn-superseded") {
    let count = 0;
    for (const [operationId, operation] of operations) {
      if (operation.turnId === turnId) {
        cancel(operationId, reason);
        count += 1;
      }
    }
    return count;
  }

  return Object.freeze({
    start,
    markCueEmitted,
    complete,
    cancel,
    cancelForTurn,
    has: (operationId) => operations.has(operationId),
    get: (operationId) => operations.get(operationId) || null,
    size: () => operations.size,
  });
}

export { CUE_INTENTS };
