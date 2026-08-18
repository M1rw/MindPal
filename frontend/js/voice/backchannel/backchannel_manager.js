import { getBackchannelDecision } from "./backchannel_policy.js";

export function createBackchannelManager({
  onRequest = () => {},
  onCancel = () => {},
  now = () => Date.now(),
  policyOptions = {},
} = {}) {
  let pending = null;
  let lastBackchannelAt = 0;

  function consider(context = {}) {
    const decision = getBackchannelDecision({
      ...context,
      lastBackchannelAt,
      pendingBackchannel: Boolean(pending),
    }, now(), policyOptions);
    if (!decision.offer) return Object.freeze(decision);
    pending = Object.freeze({
      sessionGeneration: context.sessionGeneration,
      turnId: context.turnId,
      kind: decision.kind,
      requestedAt: now(),
      context: Object.freeze({ ...context }),
    });
    onRequest(pending);
    return Object.freeze({ ...decision, request: pending });
  }

  function markEmitted({ sessionGeneration, turnId } = {}) {
    if (!pending) return false;
    if (pending.sessionGeneration !== sessionGeneration || pending.turnId !== turnId) return false;
    lastBackchannelAt = now();
    pending = null;
    return true;
  }

  function cancel(reason = "cancelled") {
    if (!pending) return false;
    const cancelled = pending;
    pending = null;
    onCancel(Object.freeze({ ...cancelled, reason, cancelledAt: now() }));
    return true;
  }

  function supersedeTurn(turnId) {
    if (!pending || pending.turnId === turnId) return false;
    return cancel("turn-superseded");
  }

  return Object.freeze({
    consider,
    markEmitted,
    cancel,
    supersedeTurn,
    hasPending: () => Boolean(pending),
    getPending: () => pending,
    getLastBackchannelAt: () => lastBackchannelAt,
  });
}
