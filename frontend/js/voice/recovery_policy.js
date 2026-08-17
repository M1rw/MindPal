// Deterministic Voice transport recovery policy.
// It is intentionally side-effect-free: runtime owns timers/WebSockets, this module
// only decides which recovery class is safe for the current provider/session state.

export const MAX_RESUMPTION_ATTEMPTS = 1;
export const MAX_TRANSIENT_RECONNECT_ATTEMPTS = 4;
export const RECOVERY_PAUSE_BASE_MS = 5_000;

export function isExpectedResumptionReason(reason) {
  return /(?:go-away|resum(?:e|ption)|session-reset)/i.test(String(reason || ""));
}

export function isCredentialExpired(expiresAt, now = Date.now(), skewMs = 5_000) {
  const timestamp = Date.parse(String(expiresAt || ""));
  return !Number.isFinite(timestamp) || timestamp <= now + skewMs;
}

export function planVoiceRecovery({
  reason = "transient",
  hasResumptionHandle = false,
  credentialExpiresAt = "",
  resumeRequested = false,
  resumptionAttempts = 0,
  transientAttempts = 0,
  recoveryCycles = 0,
  now = Date.now(),
} = {}) {
  const expectedResumption = resumeRequested || isExpectedResumptionReason(reason);
  // Runtime refreshes the one-use ephemeral credential for every physical socket.
  // A provider resumption handle has its own lifecycle, so token expiry must not
  // incorrectly discard a valid handle before one resume attempt is made.
  void credentialExpiresAt;
  void now;

  if (expectedResumption) {
    if (hasResumptionHandle && resumptionAttempts < MAX_RESUMPTION_ATTEMPTS) {
      return {
        action: "resume",
        reason: "provider-resumption",
        delayMs: 350,
        next: {
          resumptionAttempts: resumptionAttempts + 1,
          transientAttempts,
          recoveryCycles,
        },
      };
    }
    return {
      action: "reseed",
      reason: hasResumptionHandle ? "resume-fallback" : "resume-handle-unavailable",
      delayMs: 500,
      next: {
        resumptionAttempts,
        transientAttempts,
        recoveryCycles,
      },
    };
  }

  const nextTransientAttempts = transientAttempts + 1;
  if (nextTransientAttempts <= MAX_TRANSIENT_RECONNECT_ATTEMPTS) {
    return {
      action: "retry",
      reason: "transient-network",
      delayMs: Math.min(6_000, 450 * (2 ** (nextTransientAttempts - 1))),
      next: {
        resumptionAttempts,
        transientAttempts: nextTransientAttempts,
        recoveryCycles,
      },
    };
  }

  const nextCycles = recoveryCycles + 1;
  return {
    action: "pause",
    reason: "network-recovery-pause",
    delayMs: Math.min(30_000, RECOVERY_PAUSE_BASE_MS * (2 ** Math.min(nextCycles - 1, 3))),
    next: {
      resumptionAttempts,
      transientAttempts: 0,
      recoveryCycles: nextCycles,
    },
  };
}

export function resetVoiceRecoveryState() {
  return { resumptionAttempts: 0, transientAttempts: 0, recoveryCycles: 0 };
}
