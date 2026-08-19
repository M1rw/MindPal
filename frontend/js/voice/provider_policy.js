// Provider capability policy. Keep model-specific behavior centralized so the
// runtime never advertises an interaction feature that the selected Live model
// cannot actually support.

export const MINDPAL_NATIVE_AUDIO_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
export const MINDPAL_NATIVE_AUDIO_VOICE_NAME = "Kore";

export function normalizeLiveModelName(value) {
  return String(value || "").trim().replace(/^models\//, "");
}

export function isMindPalNativeAudioLiveModel(value) {
  return /^gemini-2\.5-flash-native-audio(?:-|$)/i.test(normalizeLiveModelName(value));
}

export function getLiveProviderCapabilities(model) {
  const nativeAudio = isMindPalNativeAudioLiveModel(model);
  const normalizedModel = normalizeLiveModelName(model);
  const gemini25Live = /^gemini-2\.5-flash-live(?:-|$)/i.test(normalizedModel);
  const gemini31Live = /^gemini-3\.1-flash-live(?:-|$)/i.test(normalizedModel);
  const sameSessionListeningCues = nativeAudio || gemini31Live;
  return {
    model: normalizedModel,
    nativeAudio,
    apiVersion: nativeAudio || gemini25Live ? "v1beta" : "v1alpha",
    // Gemini 2.5 Flash Live supports the documented proactive-audio path on
    // v1beta. Native Audio and Gemini 3.1 use explicit manual cue policies.
    proactiveAudio: gemini25Live,
    // Manual cue requests use realtime text/clientContent only on transports
    // where same-session cue behavior has been explicitly validated.
    nativeListeningCues: sameSessionListeningCues,
    affectiveDialog: gemini25Live,
    // The free-tier preview closed MindPal's WebSocket after the first greeting
    // when provider-declared functions were present. Keep provider functions off
    // this transport until the account/model combination is proven multi-turn
    // stable. Verified current facts still use MindPal's authenticated backend.
    providerFunctions: !nativeAudio,
    nonBlockingFunctions: gemini25Live,
    speakListeningPresence: gemini25Live,
  };
}

export function getProviderSetupCapabilities(model) {
  const capabilities = getLiveProviderCapabilities(model);
  if (!capabilities.proactiveAudio) return {};
  return {
    proactivity: { proactiveAudio: true },
    enableAffectiveDialog: true,
  };
}

export function getToolResponseScheduling({ currentFact = false } = {}) {
  // Current facts arrive through the independent verified-evidence gate and
  // must not interrupt with a speculative model answer. Other async tool
  // outcomes can arrive naturally once the model is idle.
  return currentFact ? "SILENT" : "WHEN_IDLE";
}
