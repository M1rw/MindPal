import test from "node:test";
import assert from "node:assert/strict";

import { getBackchannelDecision } from "../frontend/js/voice/backchannel/backchannel_policy.js";
import { createBackchannelManager } from "../frontend/js/voice/backchannel/backchannel_manager.js";
import { classifyResponseStage } from "../frontend/js/voice/staging/staging_policy.js";
import { createResponseStagingManager } from "../frontend/js/voice/staging/response_staging_manager.js";

test("backchannel policy allows sparse context-aware acknowledgement after a long story", () => {
  const decision = getBackchannelDecision({
    sessionGeneration: 1,
    turnId: "turn-1",
    speechDurationMs: 12_000,
    pauseDurationMs: 500,
    transcriptConfidence: 0.9,
    topic: "story",
    emotion: "sad",
  }, 10_000);
  assert.equal(decision.offer, true);
  assert.equal(decision.kind, "empathy");
});

test("backchannel policy suppresses unsafe or disruptive situations", () => {
  const base = {
    turnId: "turn-1",
    speechDurationMs: 20_000,
    transcriptConfidence: 0.9,
  };
  assert.equal(getBackchannelDecision({ ...base, safetyGate: "crisis" }).reason, "safety-gate");
  assert.equal(getBackchannelDecision({ ...base, userHasYielded: true }).reason, "user-yielded");
  assert.equal(getBackchannelDecision({ ...base, isModelSpeaking: true }).reason, "main-response-active");
  assert.equal(getBackchannelDecision({ ...base, lastBackchannelAt: 9_000 }, 12_000).reason, "cooldown");
});

test("backchannel manager emits one request and cancels it when the turn changes", () => {
  const requests = [];
  const cancellations = [];
  const manager = createBackchannelManager({
    now: () => 10_000,
    onRequest: (request) => requests.push(request),
    onCancel: (request) => cancellations.push(request),
  });
  const result = manager.consider({
    sessionGeneration: 1,
    turnId: "turn-1",
    speechDurationMs: 10_000,
    transcriptConfidence: 0.9,
    topic: "story",
    emotion: "neutral",
  });
  assert.equal(result.offer, true);
  assert.equal(requests.length, 1);
  assert.equal(manager.hasPending(), true);
  assert.equal(manager.supersedeTurn("turn-2"), true);
  assert.equal(cancellations[0].reason, "turn-superseded");
  assert.equal(manager.hasPending(), false);
});

test("response staging skips fast operations and stages slow work", () => {
  assert.equal(classifyResponseStage({ kind: "calculation", expectedLatencyMs: 200 }).stage, "answer-now");
  const decision = classifyResponseStage({ kind: "current-fact", expectedLatencyMs: 1_500 });
  assert.equal(decision.stage, "thinking-cue");
  assert.equal(decision.kind, "current-fact");
  assert.equal(classifyResponseStage({ kind: "reasoning", expectedLatencyMs: 2_000, safetyGate: "crisis" }).stage, "skip");
});

test("response staging tracks one cue per operation and cancels stale work", async () => {
  const requests = [];
  const cancellations = [];
  const manager = createResponseStagingManager({
    now: () => 20_000,
    policyOptions: { minimumCueLatencyMs: 0 },
    onRequest: (request) => requests.push(request),
    onCancel: (request) => cancellations.push(request),
  });
  const decision = manager.start({
    operationId: "operation-1",
    turnId: "turn-1",
    sessionGeneration: 1,
    kind: "memory",
    expectedLatencyMs: 1_000,
    language: "en",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(decision.stage, "thinking-cue");
  assert.equal(requests[0].cueIntent, "remembering");
  assert.equal(manager.markCueEmitted("operation-1"), true);
  assert.equal(manager.cancelForTurn("turn-1"), 1);
  assert.equal(cancellations[0].reason, "turn-superseded");
  assert.equal(manager.size(), 0);
});

test("response staging completes operation without leaking internal wording", () => {
  const manager = createResponseStagingManager({ now: () => 30_000 });
  const decision = manager.start({
    operationId: "operation-2",
    turnId: "turn-2",
    sessionGeneration: 1,
    kind: "current-fact",
    expectedLatencyMs: 2_000,
  });
  assert.equal(decision.operation.cueIntent, "checking");
  const completed = manager.complete("operation-2", { verified: true });
  assert.equal(completed.result.verified, true);
  assert.equal(manager.has("operation-2"), false);
});

import { createBackchannelProvider } from "../frontend/js/voice/backchannel/backchannel_provider.js";

test("backchannel provider stays disabled until same-session capability is validated", async () => {
  const sent = [];
  const provider = { sendText: (text) => { sent.push(text); return true; } };
  const disabled = createBackchannelProvider({ provider, capabilities: {} });
  assert.equal((await disabled.request({ kind: "empathy" })).skipped, true);
  assert.equal(sent.length, 0);

  const enabled = createBackchannelProvider({ provider, capabilities: { sameSessionBackchannel: true } });
  assert.equal((await enabled.request({ kind: "empathy" })).ok, true);
  assert.match(sent[0], /LISTENING_ACK_ONLY/);
});

import { createLocalCueManager } from "../frontend/js/voice/playback/local_cue_manager.js";

test("local cue manager never invokes remote/provider audio and is cancellable", () => {
  const events = [];
  const manager = createLocalCueManager({ onEvent: (event) => events.push(event) });
  const result = manager.play("thinking");
  assert.equal(result.skipped, true);
  assert.ok(events.some((event) => event.type === "local-cue.skipped"));
  manager.cancel("user-resumed");
  assert.equal(manager.isPlaying(), false);
});
