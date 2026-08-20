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
  const gemini25Live = false; // Retired 2.5 Live aliases are not Gemini API Live models.
  const gemini31Live = /^gemini-3\.1-flash-live(?:-|$)/i.test(normalizedModel);
  // Gemini 2.5 native audio supports clientContent updates throughout an
  // active conversation (turnComplete=false), which is the safe explicit cue
  // transport while the user turn remains open. Gemini 3.1 uses realtime text.
  const sameSessionListeningCues = nativeAudio || gemini31Live;
  return {
    model: normalizedModel,
    nativeAudio,
    apiVersion: nativeAudio || gemini25Live ? "v1beta" : "v1alpha",
    // Gemini 2.5 native audio supports the documented proactive-audio path on
    // v1beta, but proactive audio is not a reliable mid-speech acknowledgement
    // mechanism. The explicit client-content cue path remains enabled too.
    proactiveAudio: gemini25Live,
    // Manual cue requests use clientContent for Gemini 2.5 native audio and
    // realtime text for Gemini 3.1.
    nativeListeningCues: sameSessionListeningCues,
    preferRealtimeText: gemini31Live,
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
  // This constrained WebSocket has rejected both documented optional fields
  // (`proactivity` and `enableAffectiveDialog`) with code 1007 in production.
  // Keep the capability metadata for local/manual cue policy, but send only
  // the universally accepted setup fields; explicit clientContent cues provide
  // listening presence without risking setup-time schema failure.
  return {};
}

export function getToolResponseScheduling({ currentFact = false } = {}) {
  // Current facts arrive through the independent verified-evidence gate and
  // must not interrupt with a speculative model answer. Other async tool
  // outcomes can arrive naturally once the model is idle.
  return currentFact ? "SILENT" : "WHEN_IDLE";
}
