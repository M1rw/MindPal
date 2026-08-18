export function createRecoverySupervisor({
  reconnect,
  reseed,
  onEvent = () => {},
  now = () => Date.now(),
  maxAttempts = 2,
} = {}) {
  if (typeof reconnect !== "function") throw new TypeError("reconnect function is required");
  if (typeof reseed !== "function") throw new TypeError("reseed function is required");
  let active = false;
  let attempts = 0;
  let promise = null;

  function recover({ reason = "transport-close", resumeHandle = null, continuity = null } = {}) {
    if (promise) return promise;
    active = true;
    attempts += 1;
    const startedAt = now();
    onEvent({ type: "recovery.started", reason, attempts, resumeHandle });
    promise = (async () => {
      try {
        if (resumeHandle && attempts <= maxAttempts) {
          const resumed = await reconnect({ resumeHandle, reason, attempts, continuity });
          if (resumed) {
            onEvent({ type: "recovery.ready", mode: "resume", attempts, durationMs: now() - startedAt });
            return { ok: true, mode: "resume", attempts };
          }
        }
        if (attempts <= maxAttempts) {
          const reseeded = await reseed({ reason, attempts, continuity });
          if (reseeded) {
            onEvent({ type: "recovery.ready", mode: "reseed", attempts, durationMs: now() - startedAt });
            return { ok: true, mode: "reseed", attempts };
          }
        }
        const error = "voice-recovery-exhausted";
        onEvent({ type: "recovery.failed", error, attempts });
        return { ok: false, error, attempts };
      } finally {
        active = false;
        promise = null;
      }
    })();
    return promise;
  }

  function reset() {
    attempts = 0;
    active = false;
  }

  return Object.freeze({
    recover,
    reset,
    isActive: () => active,
    getAttempts: () => attempts,
  });
}
