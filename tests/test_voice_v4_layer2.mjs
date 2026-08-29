import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealtimeInputEnvelope,
  buildSetupEnvelope,
  beginSessionGeneration,
  createInitialSessionState,
  isValidAudioPart,
  parseServerMessage,
  transitionSession,
  validateInputPcmFrame,
  validateOutputPcmChunk,
} from "../frontend/js/features/voice/protocol/index.js";

const AUDIO_SENTINEL = "dGVzdA==";

function factTypes(facts) {
  return facts.map((fact) => fact.type);
}

test("parser emits independent facts for multipart server content", () => {
  const facts = parseServerMessage({
    serverContent: {
      inputTranscription: { text: "user text" },
      outputTranscription: { text: "assistant text" },
      modelTurn: {
        parts: [
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO_SENTINEL } },
          { text: "assistant text" },
        ],
      },
      generationComplete: true,
      turnComplete: true,
    },
  });

  assert.deepEqual(factTypes(facts), [
    "input_transcript",
    "output_transcript",
    "model_audio_part",
    "output_transcript",
    "generation_complete",
    "turn_complete",
  ]);
  assert.equal(facts[2].data, AUDIO_SENTINEL);
  assert.equal(facts[0].text, "user text");
  assert.equal(facts[1].text, "assistant text");
});

test("parser recognizes setup, interruption, go-away, resumption, and unexpected tools", () => {
  assert.deepEqual(factTypes(parseServerMessage({ setupComplete: {} })), ["setup_complete"]);
  assert.deepEqual(factTypes(parseServerMessage({ serverContent: { interrupted: true } })), ["interrupted"]);
  assert.deepEqual(parseServerMessage({ goAway: { timeLeftMs: 5000 } }), [{ type: "go_away", timeLeftMs: 5000 }]);
  assert.deepEqual(parseServerMessage({ sessionResumptionUpdate: { resumable: true, newHandle: "opaque-handle" } }), [{
    type: "session_resumption_update",
    resumable: true,
    hasHandle: true,
    resumptionHandle: "opaque-handle",
  }]);
  assert.deepEqual(factTypes(parseServerMessage({ toolCall: { functionCalls: [] } })), ["tool_call_unexpected"]);
  assert.deepEqual(factTypes(parseServerMessage({ error: { message: "private provider body" } })), ["provider_error"]);
  assert.equal(Object.hasOwn(parseServerMessage({ error: { message: "private provider body" } })[0], "message"), false);
});

test("parser rejects malformed audio and unknown messages without throwing", () => {
  assert.deepEqual(parseServerMessage(null), [{ type: "unknown_message", reason: "malformed_message" }]);
  assert.deepEqual(parseServerMessage({}), [{ type: "unknown_message", reason: "unrecognized_message" }]);
  assert.deepEqual(parseServerMessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "not-base64" } }] } },
  }), [{ type: "unknown_message", reason: "invalid_audio_part" }]);
  assert.deepEqual(parseServerMessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/wav", data: AUDIO_SENTINEL } }] } },
  }), [{ type: "unknown_message", reason: "invalid_audio_part" }]);
  assert.equal(isValidAudioPart({ inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO_SENTINEL } }), true);
});

test("contract builders enforce fixed setup and PCM boundaries", () => {
  const setup = buildSetupEnvelope({ instruction: "Stay concise.", voiceName: "Kore" });
  assert.equal(setup.setup.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.setup.systemInstruction.parts[0].text, "Stay concise.");
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
  assert.equal("tools" in setup.setup, false);

  const input = buildRealtimeInputEnvelope(AUDIO_SENTINEL);
  assert.equal(input.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(input.realtimeInput.audio.data, AUDIO_SENTINEL);
  assert.equal(validateInputPcmFrame(new Uint8Array([0, 1])).sampleRateHz, 16000);
  assert.equal(validateOutputPcmChunk(new Uint8Array([0, 1])).sampleRateHz, 24000);
  assert.throws(() => validateInputPcmFrame(new Uint8Array([0])));
  assert.throws(() => buildRealtimeInputEnvelope("not-base64"));
  assert.throws(() => buildSetupEnvelope({ instruction: "", voiceName: "Kore" }));
});

test("lifecycle requires setup and keeps provider facts separate from audible playback truth", () => {
  let state = createInitialSessionState(7);
  state = transitionSession(state, { type: "setup_complete", generation: 7 });
  assert.equal(state.state, "ERROR");
  assert.equal(state.lastErrorCode, "setup_before_send");

  state = createInitialSessionState(7);
  for (const fact of [
    { type: "token_requested", generation: 7 },
    { type: "socket_open", generation: 7 },
    { type: "setup_sent", generation: 7 },
    { type: "setup_complete", generation: 7 },
  ]) state = transitionSession(state, fact);

  assert.equal(state.state, "LISTENING");
  state = transitionSession(state, { type: "model_audio_part", generation: 7 });
  assert.equal(state.state, "LISTENING");
  state = transitionSession(state, { type: "output_transcript", text: "not a UI signal", generation: 7 });
  assert.equal(state.state, "LISTENING");
  state = transitionSession(state, { type: "generation_complete", generation: 7 });
  state = transitionSession(state, { type: "turn_complete", generation: 7 });
  assert.equal(state.state, "LISTENING");
  state = transitionSession(state, { type: "playback_scheduled", generation: 7 });
  assert.equal(state.state, "ASSISTANT_SPEAKING");
  state = transitionSession(state, { type: "generation_complete", generation: 7 });
  state = transitionSession(state, { type: "turn_complete", generation: 7 });
  assert.equal(state.state, "ASSISTANT_SPEAKING");
  state = transitionSession(state, { type: "playback_drained", generation: 7 });
  assert.equal(state.state, "LISTENING");
});

test("lifecycle handles capture, interruption, go-away, errors, and stale generations", () => {
  let state = beginSessionGeneration(12);
  for (const fact of [
    { type: "socket_open", generation: 12 },
    { type: "setup_sent", generation: 12 },
    { type: "setup_complete", generation: 12 },
  ]) state = transitionSession(state, fact);

  state = transitionSession(state, { type: "capture_activity", generation: 12 });
  assert.equal(state.state, "USER_SPEAKING");
  state = transitionSession(state, { type: "interrupted", generation: 12 });
  assert.equal(state.state, "INTERRUPTED");
  state = transitionSession(state, { type: "capture_activity", generation: 12 });
  assert.equal(state.state, "USER_SPEAKING");

  const stale = transitionSession(state, { type: "provider_error", code: "stale_error", generation: 11 });
  assert.equal(stale.state, "USER_SPEAKING");
  assert.equal(stale.ignoredStaleFacts, 1);
  assert.equal(stale.lastErrorCode, null);

  state = transitionSession(state, { type: "go_away", timeLeftMs: 1000, generation: 12 });
  assert.equal(state.state, "STOPPING");
  state = transitionSession(state, { type: "provider_error", code: "provider_error", generation: 12 });
  assert.equal(state.state, "ERROR");
  state = transitionSession(state, { type: "session_closed", generation: 12 });
  assert.equal(state.state, "IDLE");
});
