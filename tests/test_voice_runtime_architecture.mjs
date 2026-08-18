import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGeminiServerMessage,
  createGeminiLiveAdapter,
} from "../frontend/js/voice/provider/gemini_live_adapter.js";
import { createCaptureAdapter } from "../frontend/js/voice/capture/capture_adapter.js";
import { createPlaybackManager } from "../frontend/js/voice/playback/playback_manager.js";
import { createVoiceSessionOrchestrator } from "../frontend/js/voice/orchestrator/voice_session_orchestrator.js";
import { VOICE_EVENTS } from "../frontend/js/voice/architecture/events.js";
import { VOICE_PHASES } from "../frontend/js/voice/architecture/state.js";

test("Gemini adapter normalizes setup, transcripts, audio, interruption, and completion", () => {
  const events = normalizeGeminiServerMessage({
    setupComplete: {},
    serverContent: {
      inputTranscription: { text: "I had a difficult day" },
      outputTranscription: { text: "I hear you" },
      modelTurn: { parts: [{ inlineData: { data: "AQI=", mimeType: "audio/pcm;rate=24000" } }] },
      interrupted: true,
      turnComplete: true,
    },
  }, { sessionGeneration: 3, turnId: "turn-1", providerResponseId: "response-1", playbackGeneration: 2 });

  assert.deepEqual(events.map((event) => event.type), [
    VOICE_EVENTS.PROVIDER_READY,
    VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT,
    VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT,
    VOICE_EVENTS.PROVIDER_AUDIO,
    VOICE_EVENTS.PROVIDER_INTERRUPTED,
    VOICE_EVENTS.PROVIDER_TURN_COMPLETE,
  ]);
  assert.equal(events[3].base64Data, "AQI=");
  assert.equal(events[4].identity.turnId, "turn-1");
});

test("Gemini adapter sends setup and rejects stale sockets", () => {
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  FakeWebSocket.instances = [];
  const events = [];
  const adapter = createGeminiLiveAdapter({
    WebSocketImpl: FakeWebSocket,
    onEvent: (event) => events.push(event),
  });
  const socket = adapter.connect({
    url: "wss://example.test/live",
    setup: { model: "models/test", generationConfig: { responseModalities: ["AUDIO"] } },
    identity: { sessionGeneration: 1 },
  });
  socket.onopen();
  assert.deepEqual(socket.sent[0], { setup: { model: "models/test", generationConfig: { responseModalities: ["AUDIO"] } } });
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  assert.equal(events[0].type, VOICE_EVENTS.PROVIDER_READY);

  const firstSocket = socket;
  adapter.connect({ url: "wss://example.test/second", identity: { sessionGeneration: 2 } });
  firstSocket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  assert.equal(events.length, 1);
});

test("Gemini adapter decodes Blob setup responses from browser WebSockets", async () => {
  class BlobWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = BlobWebSocket.OPEN; }
    send() {}
    close() { this.readyState = 3; }
  }
  const events = [];
  const adapter = createGeminiLiveAdapter({ WebSocketImpl: BlobWebSocket, onEvent: (event) => events.push(event) });
  const socket = adapter.connect({ url: "wss://example.test/live", setup: { model: "models/test" }, identity: { sessionGeneration: 1 } });
  socket.onopen();
  socket.onmessage({ data: new Blob([JSON.stringify({ setupComplete: {} })], { type: "application/json" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events[0].type, VOICE_EVENTS.PROVIDER_READY);
});

test("capture adapter encodes PCM and never emits while muted or stopped", () => {
  const audio = [];
  const quality = [];
  const capture = createCaptureAdapter({
    onAudio: (frame) => audio.push(frame),
    onQuality: (signal) => quality.push(signal),
    now: (() => { let value = 100; return () => value += 10; })(),
  });
  const frame = new Float32Array([0, 0.5, -0.5, 1]);
  assert.equal(capture.processFrame(frame), false);
  capture.start();
  assert.equal(capture.processFrame(frame), true);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].mimeType, "audio/pcm;rate=16000");
  assert.match(audio[0].base64Data, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(quality.length, 1);
  capture.setMuted(true);
  assert.equal(capture.processFrame(frame), false);
  capture.stop();
  assert.equal(capture.processFrame(frame), false);
});

test("playback manager rejects stale generations and flushes active output", () => {
  const events = [];
  const playback = createPlaybackManager({ onEvent: (event) => events.push(event) });
  assert.equal(playback.schedule("AQI=", { generation: 1 }), true);
  assert.equal(playback.schedule("AQI=", { generation: 0 }), false);
  const next = playback.handleInterruption({ playbackGeneration: 1 });
  assert.equal(next, 2);
  assert.equal(playback.getActiveGeneration(), 2);
  assert.ok(events.some((event) => event.type === "playback.flushed"));
});

test("orchestrator owns session state and translates provider interruption into playback invalidation", () => {
  const providerEvents = [];
  const provider = {
    connect: ({ identity }) => { providerEvents.push(["connect", identity]); },
    updateContext: (context) => { providerEvents.push(["context", context]); },
    sendText: (text) => { providerEvents.push(["text", text]); return true; },
    close: () => { providerEvents.push(["close"]); },
  };
  const capture = createCaptureAdapter();
  const playback = createPlaybackManager();
  const orchestrator = createVoiceSessionOrchestrator({ provider, capture, playback });

  assert.equal(orchestrator.start({ url: "wss://example.test", setup: {} }), true);
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.CONNECTING);
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_READY, identity: { sessionGeneration: 1 } });
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.LISTENING);
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT, text: "hello", identity: { sessionGeneration: 1 } });
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.USER_SPEAKING);
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_AUDIO, base64Data: "AQI=", identity: { sessionGeneration: 1 } });
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.MODEL_SPEAKING);
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_INTERRUPTED, identity: { sessionGeneration: 1 } });
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.USER_SPEAKING);
  assert.equal(orchestrator.sendText("continue"), true);
  assert.equal(providerEvents.at(-1)[0], "text");
  assert.equal(orchestrator.stop(), true);
  assert.equal(orchestrator.getState().phase, VOICE_PHASES.IDLE);
});


test("playback manager ducks active model audio and restores it before provider interruption", () => {
  const events = [];
  const playback = createPlaybackManager({ onEvent: (event) => events.push(event) });
  playback.schedule("AQI=", { generation: 1 });
  assert.equal(playback.setOptimisticDucked(true), true);
  assert.ok(events.some((event) => event.type === "playback.ducked"));
  assert.equal(playback.setOptimisticDucked(false), false);
  assert.ok(events.some((event) => event.type === "playback.unducked"));
});

test("Gemini adapter exposes resumption handles and attaches them to GoAway", () => {
  const updateEvents = normalizeGeminiServerMessage({
    sessionResumptionUpdate: { newHandle: "resume-123" },
  }, { sessionGeneration: 2 });
  assert.equal(updateEvents[0].type, VOICE_EVENTS.PROVIDER_RESUMPTION_UPDATED);
  assert.equal(updateEvents[0].resumeHandle, "resume-123");
  const goAwayEvents = normalizeGeminiServerMessage({
    goAway: { timeLeft: "10s" },
  }, { sessionGeneration: 2, sessionResumptionHandle: "resume-123" });
  assert.equal(goAwayEvents[0].resumeHandle, "resume-123");
});

test("orchestrator holds tool responses until provider turn completion", async () => {
  const sent = [];
  const provider = {
    connect: () => {},
    sendToolResponse: (responses) => sent.push(responses),
    close: () => {},
  };
  const capture = createCaptureAdapter();
  const playback = createPlaybackManager();
  const toolGateway = { execute: async () => ({ answer: "verified" }) };
  const orchestrator = createVoiceSessionOrchestrator({ provider, capture, playback, toolGateway });
  orchestrator.start({ url: "wss://example.test", setup: {} });
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_READY, identity: { sessionGeneration: 1 } });
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT, text: "search this", identity: { sessionGeneration: 1 } });
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_TOOL_CALL, call: { id: "call-1", name: "search_memory", args: { query: "this" } }, identity: { sessionGeneration: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_TURN_COMPLETE, identity: { sessionGeneration: 1 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].id, "call-1");
});
