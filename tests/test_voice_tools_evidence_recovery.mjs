import test from "node:test";
import assert from "node:assert/strict";

import { createVoiceToolGateway, classifyVoiceTool } from "../frontend/js/voice/tools/tool_gateway.js";
import { executeToolClientSide } from "../frontend/js/voice/tools.js";
import { createEvidenceGate } from "../frontend/js/voice/evidence/evidence_gate.js";
import { createRecoverySupervisor } from "../frontend/js/voice/transport/recovery_supervisor.js";

test("tool gateway routes local, backend, and verified evidence without fallback", async () => {
  const calls = [];
  const gateway = createVoiceToolGateway({
    localExecutor: async (name) => { calls.push(["local", name]); return { value: 1 }; },
    backendExecutor: async (name) => { calls.push(["backend", name]); return { value: 2 }; },
    evidenceExecutor: async (name) => { calls.push(["evidence", name]); return { value: 3 }; },
  });
  assert.equal(classifyVoiceTool("current_time"), "local");
  assert.equal(classifyVoiceTool("search_memory"), "backend");
  assert.equal(classifyVoiceTool("web_search"), "verified-evidence");
  assert.deepEqual(await gateway.execute("current_time"), { value: 1 });
  assert.deepEqual(await gateway.execute("search_memory"), { value: 2 });
  assert.deepEqual(await gateway.execute("web_search"), { value: 3 });
  assert.deepEqual(calls, [["local", "current_time"], ["backend", "search_memory"], ["evidence", "web_search"]]);
});

test("client-side Voice executor refuses browser web search", async () => {
  const result = await executeToolClientSide("web_search", { query: "latest news" }, {});
  assert.match(result.error, /authenticated evidence gate/);
});

test("tool gateway returns a typed error when no trusted executor exists", async () => {
  const gateway = createVoiceToolGateway();
  const result = await gateway.execute("web_search", { query: "latest" });
  assert.match(result.error, /No verified-evidence executor/);
});

test("evidence gate releases only the current verified turn", async () => {
  const events = [];
  const gate = createEvidenceGate({
    verifier: async (query) => ({ query, source: "trusted-backend" }),
    onEvent: (event) => events.push(event),
    now: () => 10_000,
  });
  const identity = { sessionGeneration: 1, turnId: "turn-1", operationId: "operation-1" };
  const result = await gate.verify("latest weather", identity);
  assert.equal(result.status, "verified");
  assert.ok(events.some((event) => event.type === "evidence.verified"));
  assert.ok(gate.releaseIfCurrent(result, { sessionGeneration: 1, turnId: "turn-1", query: "latest weather" }));
  assert.equal(gate.releaseIfCurrent(result, { sessionGeneration: 1, turnId: "turn-2", query: "latest weather" }), null);
  assert.equal(gate.releaseIfCurrent(result, { sessionGeneration: 1, turnId: "turn-1", query: "different" }), null);
});

test("evidence gate cancels work for a superseded turn", async () => {
  let resolveVerifier;
  const gate = createEvidenceGate({
    verifier: () => new Promise((resolve) => { resolveVerifier = resolve; }),
  });
  const pending = gate.verify("current fact", { sessionGeneration: 1, turnId: "turn-1", operationId: "op-1" });
  assert.equal(gate.cancelForTurn("turn-1"), 1);
  resolveVerifier({ answer: "stale" });
  const result = await pending;
  assert.equal(result.status, "superseded");
});

test("recovery supervisor resumes once and avoids duplicate concurrent recovery", async () => {
  const events = [];
  let reconnectCalls = 0;
  const supervisor = createRecoverySupervisor({
    reconnect: async () => { reconnectCalls += 1; return true; },
    reseed: async () => false,
    onEvent: (event) => events.push(event),
  });
  const first = supervisor.recover({ reason: "go-away", resumeHandle: "handle-1" });
  const second = supervisor.recover({ reason: "duplicate" });
  assert.strictEqual(first, second);
  const result = await first;
  assert.deepEqual(result, { ok: true, mode: "resume", attempts: 1 });
  assert.equal(reconnectCalls, 1);
  assert.ok(events.some((event) => event.type === "recovery.ready"));
});

test("recovery supervisor reseeds when resumption is unavailable", async () => {
  const modes = [];
  const supervisor = createRecoverySupervisor({
    reconnect: async () => false,
    reseed: async () => { modes.push("reseed"); return true; },
  });
  const result = await supervisor.recover({ reason: "closed" });
  assert.deepEqual(result, { ok: true, mode: "reseed", attempts: 1 });
  assert.deepEqual(modes, ["reseed"]);
});

import { createVoiceSessionPersistence } from "../frontend/js/voice/lifecycle/session_persistence.js";

test("session persistence records structured close and skips incognito storage", async () => {
  const persisted = [];
  const persistence = createVoiceSessionPersistence({
    persist: async (record) => { persisted.push(record); },
    now: (() => { let value = 1_000; return () => value += 500; })(),
  });
  persistence.start({ sessionId: "session-1", incognito: false });
  persistence.update({ completedTurnCount: 2, reconnectCount: 1, userTranscript: "hello" });
  const saved = await persistence.close({ reason: "user-stop" });
  assert.equal(saved.persisted, true);
  assert.equal(persisted[0].sessionId, "session-1");
  assert.equal(persisted[0].completedTurnCount, 2);
  assert.equal(persisted[0].reason, "user-stop");
  assert.ok(persisted[0].durationMs > 0);

  const incognito = createVoiceSessionPersistence({ persist: async () => { throw new Error("must not persist"); } });
  incognito.start({ sessionId: "session-2", incognito: true });
  const skipped = await incognito.close({ reason: "user-stop" });
  assert.equal(skipped.persisted, false);
  assert.equal(skipped.record.incognito, true);
});

test("session persistence reports storage failure without crashing Voice cleanup", async () => {
  const persistence = createVoiceSessionPersistence({ persist: async () => { throw new Error("offline"); } });
  persistence.start({ sessionId: "session-3" });
  const result = await persistence.close({ reason: "transport-failure", incompleteTurn: true });
  assert.equal(result.persisted, false);
  assert.match(result.error.message, /offline/);
  assert.equal(result.record.incompleteTurn, true);
});
