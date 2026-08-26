import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
const messages = [];

globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
};

globalThis.BroadcastChannel = class BroadcastChannel {
  constructor(name) { this.name = name; }
  postMessage(message) { messages.push({ name: this.name, message }); }
};

const { emitNeuralEvent, readRecentNeuralEvents } = await import("../frontend/js/observability/neural_telemetry.js");

test("Neural Observatory emits only coarse local stage metadata", () => {
  emitNeuralEvent("attention", { inputLength: 142, durationMs: 1820, text: "must never be retained" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].name, "mindpal-neural-observatory-v1");
  assert.deepEqual(messages[0].message, {
    kind: "mindpal_neural_stage",
    stage: "attention",
    timestamp: messages[0].message.timestamp,
    input_bucket: "medium",
    duration_bucket: "normal",
    source: "mindpal_client",
  });
  assert.equal(Object.hasOwn(messages[0].message, "text"), false);
  assert.equal(JSON.stringify(readRecentNeuralEvents()).includes("must never be retained"), false);
});
