import test from "node:test";
import assert from "node:assert/strict";
import { getDefaultWorkletUrl } from "../frontend/js/voice/capture/browser_audio_adapter.js";

test("AudioWorklet uses the deployed static Voice worklet path from a bundled app", () => {
  const url = getDefaultWorkletUrl("https://mindpal.example/dist/app.bundle.js");
  assert.equal(url.href, "https://mindpal.example/js/voice/pcm_capture_worklet.js");
});

test("AudioWorklet URL remains deterministic without a browser location", () => {
  const url = getDefaultWorkletUrl("http://localhost/");
  assert.equal(url.pathname, "/js/voice/pcm_capture_worklet.js");
});
