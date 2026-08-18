const SUPPRESSED_STATUSES = new Set(["cancelled", "superseded", "failed"]);

export function createEvidenceGate({
  verifier,
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  if (typeof verifier !== "function") throw new TypeError("EvidenceGate requires a verifier function");
  const pending = new Map();

  function isCurrent(request, currentIdentity) {
    return Boolean(
      request
      && currentIdentity
      && request.identity?.sessionGeneration === currentIdentity.sessionGeneration
      && request.identity?.turnId === currentIdentity.turnId
      && request.query === currentIdentity.query
    );
  }

  async function verify(query, identity, { signal = null } = {}) {
    const operationId = identity?.operationId || `${identity?.turnId || "turn"}-evidence-${now()}`;
    const request = Object.freeze({
      operationId,
      query: String(query || "").trim(),
      identity: Object.freeze({ ...identity }),
      startedAt: now(),
      status: "pending",
    });
    if (!request.query) return { status: "failed", error: "evidence-query-required" };
    pending.set(operationId, request);
    onEvent({ type: "evidence.pending", request });

    try {
      const result = await verifier(request.query, { identity: request.identity, signal });
      const currentRequest = pending.get(operationId);
      if (!currentRequest || SUPPRESSED_STATUSES.has(currentRequest.status)) {
        return { status: "superseded", operationId };
      }
      const normalized = result && !result.error
        ? { status: "verified", operationId, query: request.query, evidence: result, identity: request.identity }
        : { status: "failed", operationId, query: request.query, error: result?.error || "verification-failed", identity: request.identity };
      pending.delete(operationId);
      onEvent({ type: normalized.status === "verified" ? "evidence.verified" : "evidence.rejected", result: normalized });
      return normalized;
    } catch (error) {
      pending.delete(operationId);
      const result = { status: "failed", operationId, query: request.query, error: error?.message || "verification-failed", identity: request.identity };
      onEvent({ type: "evidence.rejected", result });
      return result;
    }
  }

  function cancel(operationId, reason = "cancelled") {
    const request = pending.get(operationId);
    if (!request) return false;
    pending.set(operationId, Object.freeze({ ...request, status: "cancelled", reason, cancelledAt: now() }));
    onEvent({ type: "evidence.rejected", result: { status: "cancelled", operationId, reason, identity: request.identity } });
    return true;
  }

  function cancelForTurn(turnId) {
    let count = 0;
    for (const [operationId, request] of pending) {
      if (request.identity?.turnId === turnId && cancel(operationId, "turn-superseded")) count += 1;
    }
    return count;
  }

  function releaseIfCurrent(result, currentIdentity) {
    if (!result || result.status !== "verified") return null;
    if (!isCurrent(result, currentIdentity)) return null;
    return Object.freeze({ ...result, releasedAt: now() });
  }

  return Object.freeze({
    verify,
    cancel,
    cancelForTurn,
    releaseIfCurrent,
    pendingCount: () => pending.size,
  });
}
