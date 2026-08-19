import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createVoiceSessionV2, buildDeliveryDiagnosticPayload, buildAutomaticGreetingText } from "../frontend/js/voice_session_v2.js";

test("Voice v2 facade exposes the compatibility controller surface before activation", () => {
  const controller = createVoiceSessionV2({
    getAuthToken: "test-token",
    getAppCheckToken: "test-app-check",
  });
  const state = controller.getSessionState();
  assert.equal(state.isActive, false);
  assert.equal(state.phase, "idle");
  assert.equal(controller.sendTextToModel("hello"), false);
  assert.equal(controller.getMicMuted(), false);
  assert.equal(controller.getAiSpeaking(), false);
  assert.deepEqual(controller.getTranscriptSnapshot(), { userTranscript: "", aiTranscript: "" });
});

test("Voice v2 builds a user-facing automatic startup greeting", () => {
  const greeting = buildAutomaticGreetingText("ar");
  assert.match(greeting, /SESSION_START_GREETING/);
  assert.match(greeting, /in ar/);
  assert.match(greeting, /user-facing greeting/);
  assert.doesNotMatch(greeting, /internal reasoning.*expose/i);
});

test("Voice v2 builds a FastAPI-compatible aggregate diagnostic payload", () => {
  const payload = buildDeliveryDiagnosticPayload("gemini-2.5-flash-native-audio-preview-12-2025", {
    audioParts: 3,
    inputTranscriptionEvents: 2,
    outputTranscriptionEvents: 4,
    transcriptCallbackEvents: 5,
    modelTextParts: 1,
    turnCompleteEvents: 2,
    interruptedEvents: 1,
    factGatedAudioParts: 0,
  }, "transport-failure");
  assert.deepEqual(payload, {
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    audio_parts: 3,
    input_transcription_events: 2,
    output_transcription_events: 4,
    transcript_callback_events: 5,
    model_text_parts: 1,
    turn_complete_events: 2,
    interrupted_events: 1,
    fact_gated_audio_parts: 0,
    end_reason: "transport_failure",
  });
  assert.equal(Object.keys(payload).some((key) => /[A-Z]/.test(key)), false);
});

test("Voice v2 preserves mute state before the microphone adapter is ready", () => {
  const controller = createVoiceSessionV2({
    getAuthToken: "test-token",
    getAppCheckToken: "test-app-check",
  });
  assert.equal(controller.setMuted(true), true);
  assert.equal(controller.getMicMuted(), true);
  assert.equal(controller.getSessionState().isMicMuted, true);
  assert.equal(controller.setMuted(false), false);
  assert.equal(controller.getMicMuted(), false);
});

test("Voice v2 integrates canonical transcript assembly and terminal recovery notification", async () => {
  const source = await readFile(new URL("../frontend/js/voice_session_v2.js", import.meta.url), "utf8");
  assert.match(source, /createTranscriptAssembler/);
  assert.match(source, /userTranscriptAssembler\.append/);
  assert.match(source, /recovery\.failed/);
  assert.match(source, /notifySessionEndOnce\("recovery-exhausted"\)/);
  assert.match(source, /sessionEndNotified/);
});

test("Voice v2 projects lifecycle events through a safe orchestrator state accessor", async () => {
  const source = await readFile(new URL("../frontend/js/voice_session_v2.js", import.meta.url), "utf8");
  assert.match(source, /function getOrchestratorState\(\) \{[\s\S]*?orchestrator\?\.getState\?\.\(\) \|\| \{\}/);
  assert.match(source, /function projectState\(state = null\) \{[\s\S]*?const safeState = state \|\| getOrchestratorState\(\)/);
  assert.match(source, /let micMuted = false/);
  assert.match(source, /if \(!micMuted\) provider\?\.sendAudio/);
  assert.match(source, /audio\.setMuted\(micMuted\)/);
  assert.doesNotMatch(source, /orchestrator\?\.getState\?\.\(\)\.phase/);
});
