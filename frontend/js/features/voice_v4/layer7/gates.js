const MAX_EVIDENCE_ITEMS = 64;
const MAX_TEXT_LENGTH = 120;

export const LAYER7_GATE_IDS = Object.freeze(["A", "B", "C", "D", "E", "F"]);

export const LAYER7_GATE_DEFINITIONS = Object.freeze({
  A: Object.freeze({
    title: "Browser capability",
    requiredEvidence: Object.freeze(["secureContext", "microphonePermission", "audioWorklet", "audioContext", "captureGraph"]),
  }),
  B: Object.freeze({
    title: "Identity and token",
    requiredEvidence: Object.freeze(["authenticatedRequest", "constrainedToken", "shortLivedToken", "browserSecretScanClean"]),
  }),
  C: Object.freeze({
    title: "Provider setup",
    requiredEvidence: Object.freeze(["socketOpened", "setupSentOnce", "setupComplete", "audioBeforeSetupZero"]),
  }),
  D: Object.freeze({
    title: "Actual input",
    requiredEvidence: Object.freeze(["realMicrophoneSpeech", "captureFramesProduced", "framesSentAfterSetup", "providerInputTranscription", "relevantResponseObserved"]),
  }),
  E: Object.freeze({
    title: "Actual output",
    requiredEvidence: Object.freeze(["providerAudioReceived", "audioDecoded", "audioScheduled", "audioDrained", "humanAudibilityConfirmed"]),
  }),
  F: Object.freeze({
    title: "Interruption",
    requiredEvidence: Object.freeze(["speechDuringAudibleOutput", "interruptionObserved", "playbackFlushed", "nextTurnWorks", "cleanupObserved"]),
  }),
});

export function createLayer7GateRun({ runId, environment = "preview", bundleVersion = "unknown", model = "unknown" } = {}) {
  const safeRunId = normalizeRunId(runId);
  const safeEnvironment = normalizeText(environment);
  const safeBundleVersion = normalizeText(bundleVersion);
  const safeModel = normalizeText(model);
  return freezeRun({
    runId: safeRunId,
    environment: safeEnvironment,
    bundleVersion: safeBundleVersion,
    model: safeModel,
    status: "READY",
    activeGate: "A",
    gates: Object.fromEntries(LAYER7_GATE_IDS.map((id) => [id, makeGateState("PENDING")])),
  });
}

export function startLayer7Gate(run, gateId) {
  const gate = requireGate(run, gateId);
  if (run.status === "FAILED" || run.status === "PASSED") return run;
  if (gateId !== run.activeGate || gate.status !== "PENDING") throw new Error("gate_order_invalid");
  return updateGate(run, gateId, { status: "ACTIVE" }, { status: "RUNNING" });
}

export function recordLayer7Evidence(run, gateId, evidence) {
  const gate = requireGate(run, gateId);
  if (run.status !== "RUNNING" || run.activeGate !== gateId || gate.status !== "ACTIVE") throw new Error("gate_not_active");
  const safeEvidence = sanitizeEvidence(evidence);
  if (gate.evidence.length >= MAX_EVIDENCE_ITEMS) throw new Error("evidence_limit_reached");
  return updateGate(run, gateId, { evidence: [...gate.evidence, safeEvidence] });
}

export function completeLayer7Gate(run, gateId, evidence = {}) {
  if (run?.status === "FAILED" || run?.status === "PASSED") return run;
  const activeRun = run.status === "READY" || run.gates[gateId]?.status === "PENDING" ? startLayer7Gate(run, gateId) : run;
  const withEvidence = hasEntries(evidence) ? recordLayer7Evidence(activeRun, gateId, evidence) : activeRun;
  const gate = requireGate(withEvidence, gateId);
  const definition = LAYER7_GATE_DEFINITIONS[gateId];
  const mergedEvidence = Object.assign({}, ...gate.evidence);
  const missing = definition.requiredEvidence.filter((field) => mergedEvidence[field] !== true);
  if (missing.length > 0) {
    return updateGate(withEvidence, gateId, { status: "FAILED", missing }, { status: "FAILED", activeGate: null });
  }
  const nextGate = LAYER7_GATE_IDS[LAYER7_GATE_IDS.indexOf(gateId) + 1] || null;
  return updateGate(withEvidence, gateId, { status: "PASSED", missing: [] }, {
    status: nextGate ? "RUNNING" : "PASSED",
    activeGate: nextGate,
  });
}

export function failLayer7Gate(run, gateId, evidence = {}) {
  if (run?.status === "FAILED" || run?.status === "PASSED") return run;
  const activeRun = run.status === "READY" || run.gates[gateId]?.status === "PENDING" ? startLayer7Gate(run, gateId) : run;
  const withEvidence = hasEntries(evidence) ? recordLayer7Evidence(activeRun, gateId, evidence) : activeRun;
  return updateGate(withEvidence, gateId, { status: "FAILED" }, { status: "FAILED", activeGate: null });
}

function makeGateState(status) {
  return Object.freeze({ status, evidence: Object.freeze([]), missing: Object.freeze([]) });
}

function updateGate(run, gateId, gatePatch, runPatch = {}) {
  const gates = { ...run.gates, [gateId]: Object.freeze({ ...run.gates[gateId], ...gatePatch }) };
  return freezeRun({ ...run, ...runPatch, gates });
}

function requireGate(run, gateId) {
  if (!run || !LAYER7_GATE_DEFINITIONS[gateId]) throw new Error("unknown_gate");
  return run.gates[gateId];
}

function sanitizeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("evidence_must_be_object");
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
    if (typeof entry === "boolean") safe[key] = entry;
    else if (Number.isInteger(entry) && entry >= 0 && entry <= 10_000_000) safe[key] = entry;
    else if (typeof entry === "string" && entry.length <= MAX_TEXT_LENGTH && /^[A-Za-z0-9._:/-]+$/.test(entry)) safe[key] = entry;
  }
  return Object.freeze(safe);
}

function hasEntries(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function normalizeRunId(value) {
  if (typeof value !== "string" || !/^vr_[A-Za-z0-9_-]{8,72}$/.test(value)) throw new TypeError("invalid_run_id");
  return value;
}

function normalizeText(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH || !/^[A-Za-z0-9._:/-]+$/.test(value)) throw new TypeError("invalid_run_metadata");
  return value.trim();
}

function freezeRun(run) {
  return Object.freeze({ ...run, gates: Object.freeze(run.gates) });
}
