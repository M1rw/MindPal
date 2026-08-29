import { createSafeVoiceDiagnostic } from "../contracts/diagnostics.js";

export function createVoiceDiagnostics() {
  let latest = {};

  function record(entry = {}) {
    latest = createSafeVoiceDiagnostic({ ...latest, ...entry });
    return latest;
  }

  function reset() {
    latest = {};
    return latest;
  }

  return Object.freeze({
    record,
    reset,
    getSnapshot: () => latest,
  });
}
