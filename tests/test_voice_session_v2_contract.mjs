import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createVoiceSessionV2 } from "../frontend/js/voice_session_v2.js";

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

test("Voice v2 projects lifecycle events through a safe orchestrator state accessor", async () => {
  const source = await readFile(new URL("../frontend/js/voice_session_v2.js", import.meta.url), "utf8");
  assert.match(source, /function getOrchestratorState\(\) \{[\s\S]*?orchestrator\?\.getState\?\.\(\) \|\| \{\}/);
  assert.match(source, /function projectState\(state = null\) \{[\s\S]*?const safeState = state \|\| getOrchestratorState\(\)/);
  assert.match(source, /let micMuted = false/);
  assert.match(source, /if \(!micMuted\) provider\?\.sendAudio/);
  assert.match(source, /audio\.setMuted\(micMuted\)/);
  assert.doesNotMatch(source, /orchestrator\?\.getState\?\.\(\)\.phase/);
});
