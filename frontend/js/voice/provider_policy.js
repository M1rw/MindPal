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
  return {
    model: normalizeLiveModelName(model),
    nativeAudio,
    apiVersion: nativeAudio ? "v1beta" : "v1alpha",
    // The direct ephemeral-token WebSocket uses Gemini's constrained setup
    // schema. Production returned 1007 for `setup.proactivity`, so native audio
    // must not claim or send proactive-listening configuration on this path.
    // Native voice quality, barge-in, continuous capture, and v1beta remain.
    proactiveAudio: false,
    // Native cue requests use the existing realtime text channel and remain
    // separate from the unsupported setup.proactivity field.
    nativeListeningCues: nativeAudio,
    affectiveDialog: false,
    // The free-tier preview closed MindPal's WebSocket after the first greeting
    // when provider-declared functions were present. Keep provider functions off
    // this transport until the account/model combination is proven multi-turn
    // stable. Verified current facts still use MindPal's authenticated backend.
    providerFunctions: !nativeAudio,
    nonBlockingFunctions: false,
    speakListeningPresence: false,
  };
}

export function getProviderSetupCapabilities(model) {
  // Keep this explicit for future supported transports. The current browser
  // ephemeral-token constrained endpoint rejects `setup.proactivity`.
  void model;
  return {};
}

export function getToolResponseScheduling({ currentFact = false } = {}) {
  // Current facts arrive through the independent verified-evidence gate and
  // must not interrupt with a speculative model answer. Other async tool
  // outcomes can arrive naturally once the model is idle.
  return currentFact ? "SILENT" : "WHEN_IDLE";
}
