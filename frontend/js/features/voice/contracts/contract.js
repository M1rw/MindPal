export const VOICE_FEATURE_KEY = "voice.live_v4";
export const VOICE_CONTRACT_VERSION = 1;
export const PROVIDER_MODEL = "models/gemini-3.1-flash-live-preview";

export const VOICE_V4_FEATURE_KEY = VOICE_FEATURE_KEY;
export const VOICE_V4_CONTRACT_VERSION = VOICE_CONTRACT_VERSION;

export const VOICE_CONTRACT = Object.freeze({
  contractVersion: VOICE_CONTRACT_VERSION,
  featureKey: VOICE_FEATURE_KEY,
  transport: "direct_browser_google_wss",
  providerProtocol: "v1beta",
  model: PROVIDER_MODEL,
  responseModality: "AUDIO",
  inputAudio: Object.freeze({ encoding: "PCM16LE", sampleRateHz: 16000, channels: 1 }),
  outputAudio: Object.freeze({ encoding: "PCM16LE", sampleRateHz: 24000, channels: 1 }),
  baseline: Object.freeze({
    audioOnly: true,
    automaticVad: true,
    fixedSystemInstruction: true,
    oneVoice: true,
    tools: false,
    memory: false,
    reconnect: false,
    sessionResumption: false,
    dynamicAffect: false,
  }),
});

export const VOICE_V4_CONTRACT = VOICE_CONTRACT;

export const VOICE_ENVIRONMENTS = Object.freeze(["development", "preview", "staging", "production"]);
export const VOICE_V4_ENVIRONMENTS = VOICE_ENVIRONMENTS;

export const VOICE_RELEASE_REASONS = Object.freeze({
  ENABLED: "enabled",
  FEATURE_MISSING: "feature_missing",
  WRONG_FEATURE: "wrong_feature",
  FEATURE_DISABLED: "feature_disabled",
  FEATURE_LIFECYCLE_BLOCKED: "feature_lifecycle_blocked",
  APPROVAL_REQUIRED: "approval_required",
  INVALID_ENVIRONMENT: "invalid_environment",
});

export const VOICE_V4_RELEASE_REASONS = VOICE_RELEASE_REASONS;

export function evaluateVoiceRelease(featureState, {
  environment,
  explicitApproval = false,
} = {}) {
  const normalizedEnvironment = String(environment || "").trim().toLowerCase();
  if (!VOICE_ENVIRONMENTS.includes(normalizedEnvironment)) {
    return releaseDecision("production", false, VOICE_RELEASE_REASONS.INVALID_ENVIRONMENT);
  }
  if (!featureState || featureState.key !== VOICE_FEATURE_KEY) {
    return releaseDecision(
      normalizedEnvironment,
      false,
      featureState ? VOICE_RELEASE_REASONS.WRONG_FEATURE : VOICE_RELEASE_REASONS.FEATURE_MISSING
    );
  }
  if (featureState.enabled !== true) {
    return releaseDecision(normalizedEnvironment, false, VOICE_RELEASE_REASONS.FEATURE_DISABLED);
  }
  if (["maintenance", "disabled", "deprecated"].includes(featureState.lifecycle)) {
    return releaseDecision(normalizedEnvironment, false, VOICE_RELEASE_REASONS.FEATURE_LIFECYCLE_BLOCKED);
  }
  if (explicitApproval !== true) {
    return releaseDecision(normalizedEnvironment, false, VOICE_RELEASE_REASONS.APPROVAL_REQUIRED);
  }
  return releaseDecision(normalizedEnvironment, true, VOICE_RELEASE_REASONS.ENABLED);
}

export const evaluateVoiceV4Release = evaluateVoiceRelease;

function releaseDecision(environment, allowed, reason) {
  return Object.freeze({
    featureKey: VOICE_FEATURE_KEY,
    environment,
    allowed,
    reason,
    contractVersion: VOICE_CONTRACT_VERSION,
  });
}
