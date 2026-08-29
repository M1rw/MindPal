import assert from "node:assert/strict";
import test from "node:test";

import {
  VOICE_V4_CONTRACT,
  VOICE_V4_FEATURE_KEY,
  evaluateVoiceV4Release,
} from "../frontend/js/features/voice/contracts/contract.js";
import { createSafeVoiceDiagnostic } from "../frontend/js/features/voice/contracts/diagnostics.js";

test("Layer 0 contract is audio-only and keeps later runtime features disabled", () => {
  assert.equal(VOICE_V4_CONTRACT.featureKey, VOICE_V4_FEATURE_KEY);
  assert.equal(VOICE_V4_CONTRACT.inputAudio.sampleRateHz, 16000);
  assert.equal(VOICE_V4_CONTRACT.outputAudio.sampleRateHz, 24000);
  assert.equal(VOICE_V4_CONTRACT.baseline.tools, false);
  assert.equal(VOICE_V4_CONTRACT.baseline.memory, false);
  assert.equal(VOICE_V4_CONTRACT.baseline.dynamicAffect, false);
  // Client VAD and resilience features are now enabled
  assert.equal(VOICE_V4_CONTRACT.baseline.clientVad, true);
  assert.equal(VOICE_V4_CONTRACT.baseline.reconnect, true);
  assert.equal(VOICE_V4_CONTRACT.baseline.sessionResumption, true);
});

test("release gate requires explicit approval in every release environment", () => {
  const feature = { key: VOICE_V4_FEATURE_KEY, enabled: true, lifecycle: "preview" };

  assert.equal(evaluateVoiceV4Release(feature, { environment: "preview" }).allowed, false);
  assert.equal(evaluateVoiceV4Release(feature, { environment: "preview" }).reason, "approval_required");
  assert.equal(evaluateVoiceV4Release(feature, { environment: "preview", explicitApproval: true }).allowed, true);
  assert.equal(evaluateVoiceV4Release(feature, { environment: "production", explicitApproval: true }).allowed, true);
  assert.equal(evaluateVoiceV4Release(feature, { environment: "production", explicitApproval: true }).reason, "enabled");
});

test("release gate fails closed for missing, disabled, blocked, and invalid states", () => {
  assert.equal(evaluateVoiceV4Release(null, { environment: "preview", explicitApproval: true }).reason, "feature_missing");
  assert.equal(evaluateVoiceV4Release({ key: VOICE_V4_FEATURE_KEY, enabled: false, lifecycle: "preview" }, { environment: "preview", explicitApproval: true }).reason, "feature_disabled");
  assert.equal(evaluateVoiceV4Release({ key: VOICE_V4_FEATURE_KEY, enabled: true, lifecycle: "maintenance" }, { environment: "preview", explicitApproval: true }).reason, "feature_lifecycle_blocked");
  assert.equal(evaluateVoiceV4Release({ key: "chat.standard_model", enabled: true, lifecycle: "active" }, { environment: "preview", explicitApproval: true }).reason, "wrong_feature");
  assert.equal(evaluateVoiceV4Release({ key: VOICE_V4_FEATURE_KEY, enabled: true, lifecycle: "preview" }, { environment: "invalid", explicitApproval: true }).reason, "invalid_environment");
});

test("diagnostic sanitizer strips tokens, PCM, transcripts, prompts, URLs, and unknown fields", () => {
  const result = createSafeVoiceDiagnostic({
    sessionId: "vs_12345678",
    event: "playback_snapshot",
    state: "ASSISTANT_SPEAKING",
    generation: 3,
    queueDepthMs: 640,
    errorCode: "provider_unavailable",
    token: "secret-token-value",
    pcm: "raw-audio-bytes",
    transcript: "private transcript",
    prompt: "private prompt",
    providerUrl: "wss://provider.invalid/private",
  });

  assert.deepEqual(result, {
    sessionId: "vs_12345678",
    event: "playback_snapshot",
    state: "ASSISTANT_SPEAKING",
    generation: 3,
    queueDepthMs: 640,
    errorCode: "provider_unavailable",
  });
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(Object.hasOwn(result, "pcm"), false);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.equal(Object.hasOwn(result, "prompt"), false);
  assert.equal(Object.hasOwn(result, "providerUrl"), false);
});

test("invalid diagnostic values fail closed without carrying arbitrary strings", () => {
  const result = createSafeVoiceDiagnostic({
    event: "raw_provider_event",
    state: "UNKNOWN_STATE",
    audioContextState: "private-provider-state",
    messageCategory: "private-provider-payload",
    generation: -1,
  });

  assert.deepEqual(result, { event: "unknown" });
});
