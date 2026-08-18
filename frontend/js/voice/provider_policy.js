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
    // Native 2.5 Live supports proactive audio. Gemini 3.1 Live does not, so
    // the runtime must not send unsupported setup fields or claim full duplex.
    proactiveAudio: nativeAudio,
    affectiveDialog: false,
    // The free-tier preview closed MindPal's WebSocket after the first greeting
    // when provider-declared functions were present. Keep provider functions off
    // this transport until the account/model combination is proven multi-turn
    // stable. Verified current facts still use MindPal's authenticated backend.
    providerFunctions: !nativeAudio,
    nonBlockingFunctions: false,
    speakListeningPresence: nativeAudio,
  };
}

export function getProviderSetupCapabilities(model) {
  const capabilities = getLiveProviderCapabilities(model);
  const setup = {};
  if (capabilities.proactiveAudio) setup.proactivity = { proactiveAudio: true };
  // Proactive Audio and Affective Dialog are deliberately not combined. The
  // product needs natural, interruption-safe conversational presence first;
  // emotion remains guided by the system prompt until a provider-supported
  // combined configuration is explicitly validated.
  if (capabilities.affectiveDialog) setup.enableAffectiveDialog = true;
  return setup;
}

export function getToolResponseScheduling({ currentFact = false } = {}) {
  // Current facts arrive through the independent verified-evidence gate and
  // must not interrupt with a speculative model answer. Other async tool
  // outcomes can arrive naturally once the model is idle.
  return currentFact ? "SILENT" : "WHEN_IDLE";
}
