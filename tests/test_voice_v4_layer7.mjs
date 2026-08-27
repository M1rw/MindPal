import assert from "node:assert/strict";
import test from "node:test";

import {
  LAYER7_GATE_IDS,
  completeLayer7Gate,
  createLayer7EvidenceCollector,
  createLayer7GateRun,
  failLayer7Gate,
  recordLayer7Evidence,
  startLayer7Gate,
  createVoiceV4PreviewSessionFactory,
} from "../frontend/js/features/voice_v4/layer7/index.js";

const RUN = { runId: "vr_layer7_test", environment: "preview", bundleVersion: "1eb61d8", model: "gemini-live" };

const COMPLETE_EVIDENCE = {
  A: { secureContext: true, microphonePermission: true, audioWorklet: true, audioContext: true, captureGraph: true },
  B: { authenticatedRequest: true, constrainedToken: true, shortLivedToken: true, browserSecretScanClean: true },
  C: { socketOpened: true, setupSentOnce: true, setupComplete: true, audioBeforeSetupZero: true },
  D: { realMicrophoneSpeech: true, captureFramesProduced: true, framesSentAfterSetup: true, providerInputTranscription: true, relevantResponseObserved: true },
  E: { providerAudioReceived: true, audioDecoded: true, audioScheduled: true, audioDrained: true, humanAudibilityConfirmed: true },
  F: { speechDuringAudibleOutput: true, interruptionObserved: true, playbackFlushed: true, nextTurnWorks: true, cleanupObserved: true },
};

test("all Layer 7 gates pass only in order and produce an immutable completed run", () => {
  let run = createLayer7GateRun(RUN);
  for (const gateId of LAYER7_GATE_IDS) run = completeLayer7Gate(run, gateId, COMPLETE_EVIDENCE[gateId]);
  assert.equal(run.status, "PASSED");
  assert.equal(run.activeGate, null);
  for (const gateId of LAYER7_GATE_IDS) assert.equal(run.gates[gateId].status, "PASSED");
  assert.equal(Object.isFrozen(run), true);
  assert.equal(Object.isFrozen(run.gates), true);
});

test("a gate with missing required evidence fails and blocks later gates", () => {
  let run = createLayer7GateRun(RUN);
  run = completeLayer7Gate(run, "A", { secureContext: true, microphonePermission: true });
  assert.equal(run.status, "FAILED");
  assert.deepEqual(run.gates.A.missing, ["audioWorklet", "audioContext", "captureGraph"]);
  assert.equal(run.activeGate, null);
  assert.equal(run.gates.B.status, "PENDING");
  assert.equal(completeLayer7Gate(run, "B", COMPLETE_EVIDENCE.B), run);
});

test("gate order cannot be skipped or advanced after a terminal failure", () => {
  const run = createLayer7GateRun(RUN);
  assert.throws(() => startLayer7Gate(run, "B"), /gate_order_invalid/);
  const failed = failLayer7Gate(run, "A", { secureContext: false });
  assert.equal(failed.status, "FAILED");
  assert.equal(startLayer7Gate(failed, "B"), failed);
});

test("evidence entries are bounded and exclude secrets, content, and arbitrary fields", () => {
  const collector = createLayer7EvidenceCollector({ runId: "vr_layer7_test", clock: () => 123.9 });
  const entry = collector.record({
    gate: "E",
    state: "ASSISTANT_SPEAKING",
    facts: {
      providerAudioReceived: true,
      audioScheduled: true,
      token: "secret",
      transcript: "private words",
      prompt: "private instruction",
      pcm: "raw bytes",
      url: "https://private.example",
      queueDepthMs: 120,
      activeSources: 1,
      unknownField: "discarded",
    },
  });
  assert.equal(entry.runId, "vr_layer7_test");
  assert.equal(entry.at, 123);
  assert.equal(entry.providerAudioReceived, true);
  assert.equal(entry.queueDepthMs, 120);
  assert.equal(entry.activeSources, 1);
  assert.equal("token" in entry, false);
  assert.equal("transcript" in entry, false);
  assert.equal("prompt" in entry, false);
  assert.equal("pcm" in entry, false);
  assert.equal("url" in entry, false);
  assert.equal("unknownField" in entry, false);
});

test("manual evidence recording requires an active gate and does not mutate prior snapshots", () => {
  const initial = createLayer7GateRun(RUN);
  assert.throws(() => recordLayer7Evidence(initial, "A", { secureContext: true }), /gate_not_active/);
  const active = startLayer7Gate(initial, "A");
  const recorded = recordLayer7Evidence(active, "A", { secureContext: true });
  assert.equal(active.gates.A.evidence.length, 0);
  assert.equal(recorded.gates.A.evidence.length, 1);
  assert.equal(recorded.gates.A.evidence[0].secureContext, true);
});

test("preview session composition is disabled outside staging and uses only injected browser dependencies", async () => {
  const common = {
    enabled: true,
    explicitApproval: true,
    apiBaseUrl: "/api",
    getFeatureState: () => ({ key: "voice.live_v4", enabled: true, lifecycle: "preview" }),
    getReleaseDecision: () => ({ allowed: true }),
    getIdToken: async () => "id-token-test",
    getAppCheckToken: async () => "app-check-test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: "t", expires_at_utc: "2099-01-01T00:00:00Z" }) }),
    WebSocketConstructor: class FakeWebSocket {
      constructor(url) { this.url = url; this.sent = []; }
      send(value) { this.sent.push(value); }
      close() {}
    },
    captureFactory: () => ({ start: async () => {}, stop: async () => {} }),
    playbackFactory: () => ({ start: async () => {}, close: async () => {}, schedulePcm24: () => ({}), flush: () => ({}), onDrain: () => () => {} }),
    processorUrl: "https://preview.example/worklet.js",
  };
  assert.equal(createVoiceV4PreviewSessionFactory({ ...common, environment: "production" }), undefined);

  const requests = [];
  const PreviewWebSocket = class FakePreviewWebSocket {
    constructor(url) { this.url = url; this.sent = []; }
    send(value) { this.sent.push(value); }
    close() {}
  };
  const factory = createVoiceV4PreviewSessionFactory({
    ...common,
    environment: "staging",
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return { ok: true, json: async () => ({ token: "t", expires_at_utc: "2099-01-01T00:00:00Z" }) };
    },
    WebSocketConstructor: PreviewWebSocket,
  });
  const session = factory({ onStateChange: () => {}, onFact: () => {}, onTranscript: () => {}, onError: () => {} });
  await session.start();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/voice/v4/token");
  assert.equal(requests[0].headers.Authorization, "Bearer id-token-test");
  assert.equal(requests[0].headers["X-Firebase-AppCheck"], "app-check-test");
});
