import test from "node:test";
import assert from "node:assert/strict";

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
