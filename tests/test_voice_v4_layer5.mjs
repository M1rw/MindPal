import assert from "node:assert/strict";
import test from "node:test";

import {
  VoiceSessionError,
  createVoiceSession,
} from "../frontend/js/features/voice/orchestrator/index.js";

const AUDIO_SENTINEL = "AAE=";

function createHarness() {
  const socket = {
    readyState: 1,
    sent: [],
    closed: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(message) { this.sent.push(JSON.parse(message)); },
    close(code, reason) { this.closed = { code, reason }; },
  };
  const capture = {
    started: 0,
    stopped: 0,
    onFrame: null,
    onError: null,
    async start() { this.started += 1; },
    async stop() { this.stopped += 1; },
    emitFrame(bytes) { this.onFrame?.(bytes); },
    emitError(error) { this.onError?.(error); },
  };
  const playback = {
    started: 0,
    closed: 0,
    flushed: [],
    scheduled: [],
    drainListener: null,
    async start() { this.started += 1; },
    schedulePcm24(bytes) { this.scheduled.push(bytes); return { queueDepthMs: 20 }; },
    flush(reason) { this.flushed.push(reason); return { playbackEpoch: this.flushed.length }; },
    close() { this.closed += 1; },
    onDrain(listener) { this.drainListener = listener; return () => { this.drainListener = null; }; },
    emitDrain() { this.drainListener?.({ queueDepthMs: 0 }); },
  };
  const calls = { token: 0, sockets: 0 };
  const tokenProvider = {
    async issueToken() {
      calls.token += 1;
      return { token: "ephemeral-token", expires_at_utc: "2026-08-27T00:30:00Z" };
    },
  };
  const session = createVoiceSession({
    tokenProvider,
    socketFactory: async () => {
      calls.sockets += 1;
      return socket;
    },
    captureFactory: (options) => { Object.assign(capture, options); return capture; },
    playbackFactory: (options) => { Object.assign(playback, options); return playback; },
    instruction: "Use the approved baseline voice instruction.",
    voiceName: "Kore",
  });
  return { session, socket, capture, playback, calls };
}

async function finishMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("session owns one socket and sends no audio before provider setup", async () => {
  const harness = createHarness();
  await harness.session.start();
  assert.equal(harness.calls.token, 1);
  assert.equal(harness.calls.sockets, 1);
  assert.equal(harness.socket.sent.length, 1);
  assert.equal(harness.socket.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual(harness.socket.sent[0].setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(harness.capture.started, 0);

  harness.capture.emitFrame(new Uint8Array([0, 1]));
  assert.equal(harness.socket.sent.length, 1);

  harness.socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  await finishMicrotasks();
  assert.equal(harness.capture.started, 1);
  assert.equal(harness.playback.started, 1);
  assert.equal(harness.session.getState().state, "LISTENING");

  harness.capture.emitFrame(new Uint8Array([0, 1]));
  assert.equal(harness.socket.sent.length, 2);
  assert.equal(harness.socket.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(harness.socket.sent[1].realtimeInput.audio.data, "AAE=");
});

test("session forwards every model audio part, keeps transcripts independent, and flushes interruption", async () => {
  const harness = createHarness();
  const transcripts = [];
  const facts = [];
  const session = createVoiceSession({
    tokenProvider: { issueToken: async () => ({ token: "token", expires_at_utc: "2026-08-27T00:30:00Z" }) },
    socketFactory: async () => harness.socket,
    captureFactory: (options) => { Object.assign(harness.capture, options); return harness.capture; },
    playbackFactory: (options) => { Object.assign(harness.playback, options); return harness.playback; },
    instruction: "Baseline.",
    onTranscript: (fact) => transcripts.push(fact),
    onFact: (fact) => facts.push(fact),
  });
  await session.start();
  harness.socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  await finishMicrotasks();

  harness.socket.onmessage({ data: JSON.stringify({
    serverContent: {
      outputTranscription: { text: "caption only" },
      modelTurn: { parts: [
        { inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO_SENTINEL } },
        { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AgM=" } },
      ] },
    },
  }) });
  assert.equal(harness.playback.scheduled.length, 2);
  assert.equal(transcripts.length, 1);
  assert.equal(session.getState().state, "ASSISTANT_SPEAKING");
  assert.equal(facts.filter((fact) => fact.type === "model_audio_part").length, 0);

  harness.socket.onmessage({ data: JSON.stringify({ serverContent: { interrupted: true } }) });
  assert.deepEqual(harness.playback.flushed, ["provider_interrupted"]);
  assert.equal(session.getState().state, "INTERRUPTED");
  harness.playback.emitDrain();
  assert.equal(session.getState().state, "INTERRUPTED");
});

test("session emits playback drain fact only from playback and fully cleans up on stop", async () => {
  const harness = createHarness();
  const session = harness.session;
  await session.start();
  harness.socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  await finishMicrotasks();
  harness.socket.onmessage({ data: JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO_SENTINEL } }] } },
  }) });
  assert.equal(session.getState().state, "ASSISTANT_SPEAKING");
  harness.playback.emitDrain();
  assert.equal(session.getState().state, "LISTENING");

  const oldGeneration = session.getGeneration();
  await session.stop("user_stop");
  assert.equal(session.getState().state, "IDLE");
  assert.ok(session.getGeneration() > oldGeneration);
  assert.equal(harness.capture.stopped, 1);
  assert.equal(harness.playback.closed, 1);
  assert.deepEqual(harness.socket.closed, { code: 1000, reason: "session_end" });
});

test("session ignores old-generation socket and capture callbacks after stop", async () => {
  const harness = createHarness();
  await harness.session.start();
  harness.socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  await finishMicrotasks();
  const oldMessageHandler = harness.socket.onmessage;
  const generation = harness.session.getGeneration();
  await harness.session.stop();
  oldMessageHandler({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO_SENTINEL } }] } } }) });
  harness.capture.emitFrame(new Uint8Array([0, 1]));
  assert.equal(harness.playback.scheduled.length, 0);
  assert.equal(harness.session.getGeneration() > generation, true);
});

test("socket close fails visibly without reconnecting", async () => {
  const harness = createHarness();
  const errors = [];
  const session = createVoiceSession({
    tokenProvider: { issueToken: async () => ({ token: "token", expires_at_utc: "2026-08-27T00:30:00Z" }) },
    socketFactory: async () => { harness.calls.sockets += 1; return harness.socket; },
    captureFactory: () => harness.capture,
    playbackFactory: () => harness.playback,
    instruction: "Baseline.",
    onError: (error) => errors.push(error),
  });
  await session.start();
  harness.socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  await finishMicrotasks();
  harness.socket.onclose();
  await finishMicrotasks();
  assert.equal(session.getState().state, "ERROR");
  assert.equal(errors.at(-1).code, "provider_socket_closed");
  assert.equal(harness.capture.stopped, 1);
  assert.equal(harness.playback.closed, 1);
  assert.equal(harness.calls.sockets, 1);
});

test("session validates required dependencies and rejects duplicate starts", async () => {
  assert.throws(() => createVoiceSession({ instruction: "" }), (error) => error instanceof VoiceSessionError && error.code === "instruction_invalid");
  const harness = createHarness();
  await harness.session.start();
  await assert.rejects(() => harness.session.start(), (error) => error instanceof VoiceSessionError && error.code === "session_already_active");
});
