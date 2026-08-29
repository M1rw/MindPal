import assert from "node:assert/strict";
import test from "node:test";

import { createSafeVoiceDiagnostic } from "../frontend/js/features/voice/contracts/diagnostics.js";
import { createVoiceConsentController } from "../frontend/js/features/voice/ui/consent.js";
import { createVoiceDiagnostics } from "../frontend/js/features/voice/ui/diagnostics.js";
import { createVoiceLayer6Controller } from "../frontend/js/features/voice/ui/controller.js";
import { createVoiceViewModel } from "../frontend/js/features/voice/ui/view_model.js";

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : force;
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(id, initialClasses = []) {
    this.id = id;
    this.classList = new FakeClassList(initialClasses);
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.disabled = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async dispatch(type) { return this.listeners.get(type)?.({ currentTarget: this }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.attributes.has(name) : force;
    if (enabled) this.attributes.set(name, ""); else this.attributes.delete(name);
    if (name === "disabled") this.disabled = enabled;
    return enabled;
  }
  append(child) { this.children.push(child); this.textContent += child.textContent; this.scrollHeight = this.children.length; }
  replaceChildren() { this.children = []; this.textContent = ""; }
}

function createDocument() {
  const ids = [
    "voice-live-overlay", "voice-btn", "voice-live-status", "voice-face-state-label", "voice-startup-spinner",
    "voice-transcript-panel", "voice-live-close", "voice-live-close-bottom", "voice-cc-toggle", "voice-mute-toggle",
    "voice-mute-label", "voice-consent-panel", "voice-consent-allow", "voice-consent-decline", "voice-safe-diagnostics",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id, id === "voice-live-overlay" ? ["hidden", "opacity-0", "pointer-events-none"] : [])]));
  return {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => new FakeElement(tagName),
    elements,
  };
}

const enabledFeature = { key: "voice.live_v4", enabled: true, lifecycle: "preview" };
const allowedRelease = { allowed: true, reason: "enabled" };

function createSessionHarness(documentRef) {
  const calls = { created: 0, started: 0, stopped: 0 };
  let callbacks;
  const controller = createVoiceLayer6Controller({
    documentRef,
    getFeatureState: () => enabledFeature,
    getReleaseDecision: () => allowedRelease,
    createSession: (options) => {
      calls.created += 1;
      callbacks = options;
      return {
        async start() { calls.started += 1; },
        async stop() { calls.stopped += 1; },
      };
    },
    getDiagnosticsEnabled: () => true,
  });
  return { controller, calls, getCallbacks: () => callbacks };
}

test("disabled release gate keeps the trigger inactive and never creates a session", async () => {
  const documentRef = createDocument();
  let created = 0;
  const controller = createVoiceLayer6Controller({
    documentRef,
    getFeatureState: () => ({ key: "voice.live_v4", enabled: false, lifecycle: "disabled" }),
    getReleaseDecision: () => ({ allowed: false, reason: "feature_disabled" }),
    createSession: () => { created += 1; return null; },
  });
  controller.bind();
  await documentRef.elements.get("voice-btn").dispatch("click");
  assert.equal(documentRef.elements.get("voice-btn").disabled, true);
  assert.equal(created, 0);
  assert.equal(documentRef.elements.get("voice-live-status").textContent, "Voice unavailable");
});

test("consent is explicit, per-session, and starts the session only after Allow microphone", async () => {
  const documentRef = createDocument();
  const harness = createSessionHarness(documentRef);
  harness.controller.bind();
  await documentRef.elements.get("voice-btn").dispatch("click");
  assert.equal(documentRef.elements.get("voice-consent-panel").classList.contains("hidden"), false);
  assert.equal(harness.calls.created, 0);
  await documentRef.elements.get("voice-consent-allow").dispatch("click");
  await Promise.resolve();
  assert.equal(harness.calls.created, 1);
  assert.equal(harness.calls.started, 1);
  assert.equal(harness.controller.getConsentState(), "granted");
  await harness.controller.endSession("user_close");
  assert.equal(harness.calls.stopped, 1);
  assert.equal(harness.controller.getConsentState(), "unknown");
  assert.equal(documentRef.elements.get("voice-live-overlay").classList.contains("hidden"), true);
});

test("status mapping never claims speaking from a transcript or scheduled generation without active playback", () => {
  const featureState = { key: "voice.live_v4", enabled: true, lifecycle: "preview" };
  const releaseDecision = { allowed: true };
  assert.equal(createVoiceViewModel({ featureState, releaseDecision, sessionState: { state: "ASSISTANT_SPEAKING" }, playbackSnapshot: { activeSourceCount: 0 } }).status, "MindPal is generating");
  assert.equal(createVoiceViewModel({ featureState, releaseDecision, sessionState: { state: "ASSISTANT_SPEAKING" }, playbackSnapshot: { activeSourceCount: 1 } }).status, "MindPal is speaking");
});

test("controller renders captions separately and keeps diagnostics bounded and redacted", async () => {
  const documentRef = createDocument();
  const harness = createSessionHarness(documentRef);
  harness.controller.bind();
  await documentRef.elements.get("voice-btn").dispatch("click");
  await documentRef.elements.get("voice-consent-allow").dispatch("click");
  await Promise.resolve();
  const callbacks = harness.getCallbacks();
  callbacks.onStateChange({ state: "ASSISTANT_SPEAKING", generation: 4, setupComplete: true });
  callbacks.onFact({ type: "playback_scheduled", generation: 4, queueDepthMs: 120, activeSourceCount: 1 });
  callbacks.onTranscript({ type: "output_transcript", text: "caption is visible here" });
  assert.equal(documentRef.elements.get("voice-live-status").textContent, "MindPal is speaking");
  assert.equal(documentRef.elements.get("voice-transcript-panel").textContent, "caption is visible here");
  const diagnosticText = documentRef.elements.get("voice-safe-diagnostics").textContent;
  assert.match(diagnosticText, /queueDepthMs: 120/);
  assert.doesNotMatch(diagnosticText, /caption is visible here|token|prompt|pcm|https?:/i);
});

test("consent and diagnostics primitives reject persistence and forbidden fields", () => {
  const changes = [];
  const consent = createVoiceConsentController({ onChange: (state) => changes.push(state) });
  consent.allow();
  consent.reset();
  assert.deepEqual(changes, ["granted", "unknown"]);
  assert.equal(consent.getState(), "unknown");

  const diagnostics = createVoiceDiagnostics({ sessionId: "vs_12345678" });
  const snapshot = diagnostics.record({
    event: "error", state: "ERROR", errorCode: "provider_failed", generation: 3,
    transcript: "private", prompt: "private", token: "private", pcm: "private", url: "https://private.example",
  });
  assert.equal(snapshot.generation, 3);
  assert.equal("transcript" in snapshot, false);
  assert.equal("prompt" in snapshot, false);
  assert.equal("token" in snapshot, false);
  assert.equal("pcm" in snapshot, false);
  assert.equal("url" in snapshot, false);
  assert.deepEqual(createSafeVoiceDiagnostic({ state: "ERROR", rawProviderBody: "private" }).rawProviderBody, undefined);
});
