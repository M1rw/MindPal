import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveVoiceFaceState,
  getVoiceFaceSnapshot,
  setVoiceFaceState,
} from "../frontend/js/voice/voice_face_visualizer.js";

test("maps the real Voice lifecycle into intentional face expressions", () => {
  assert.equal(deriveVoiceFaceState({ phase: "connecting" }).expression, "connecting");
  assert.equal(deriveVoiceFaceState({ phase: "listening", micLevel: 0.01 }).expression, "neutral");
  assert.equal(deriveVoiceFaceState({ phase: "listening", micLevel: 0.2 }).expression, "listening");
  assert.equal(deriveVoiceFaceState({ phase: "thinking", backgroundTaskActive: true }).expression, "thinking");
  assert.equal(deriveVoiceFaceState({ phase: "speaking", isAiSpeaking: true }).expression, "speaking");
});

test("prioritizes backchannel, mute, and error signals without inventing audio state", () => {
  assert.equal(deriveVoiceFaceState({ phase: "listening", interactionTag: "native-backchannel" }).expression, "backchannel");
  assert.equal(deriveVoiceFaceState({ phase: "listening", isMicMuted: true, micLevel: 0.9 }).expression, "muted");
  assert.equal(deriveVoiceFaceState({ phase: "speaking", isAiSpeaking: true, error: true }).expression, "error");
  assert.equal(deriveVoiceFaceState({ phase: "provider-error" }).label, "Voice connection error");
});

test("state updates remain inspectable when the overlay is not mounted", () => {
  const mapped = setVoiceFaceState({ phase: "thinking", backgroundTaskActive: true });
  assert.equal(mapped.expression, "thinking");
  const snapshot = getVoiceFaceSnapshot();
  assert.equal(snapshot.expression, "thinking");
  assert.equal(snapshot.running, false);
});
