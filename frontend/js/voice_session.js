// MindPal production voice facade.
// Voice V3 is now the active implementation. The former V2 facade remains
// available under frontend/js/voice/archive for rollback and contract tests.

const EMPTY_STATE = Object.freeze({
  isActive: false,
  isMicMuted: false,
  isAiSpeaking: false,
  isSpeakerMuted: false,
  phase: "idle",
  reconnectAttempts: 0,
  micAnalyser: null,
  aiAnalyser: null,
});

let controller = null;
let controllerPromise = null;

async function loadController() {
  if (controller) return controller;
  if (!controllerPromise) {
    const runtimeUrl = new URL("../voice-v3/assets/runtime.js", import.meta.url);
    controllerPromise = import(runtimeUrl.href)
      .then((runtime) => {
        const factory = runtime.createVoiceV3Controller || globalThis.window?.__MINDPAL_VOICE_V3_RUNTIME__?.createVoiceV3Controller;
        if (typeof factory !== "function") throw new Error("MindPal Voice V3 runtime did not expose a controller factory");
        controller = factory();
        return controller;
      })
      .catch((error) => {
        controllerPromise = null;
        throw error;
      });
  }
  return controllerPromise;
}

export function getSessionState() {
  return controller?.getSessionState?.() || EMPTY_STATE;
}

export function getMicMuted() { return controller?.getMicMuted?.() || false; }
export function getAiSpeaking() { return controller?.getAiSpeaking?.() || false; }
export function getSpeakerMuted() { return controller?.getSpeakerMuted?.() || false; }
export function getTranscriptSnapshot() {
  return controller?.getTranscriptSnapshot?.() || { userTranscript: "", aiTranscript: "" };
}

export function setSpeakerMuted(muted) {
  if (!controller) return Boolean(muted);
  return controller.setSpeakerMuted(Boolean(muted));
}

export function setMuted(muted) {
  if (!controller) return Boolean(muted);
  return controller.setMuted(Boolean(muted));
}

export async function startSession(options = {}) {
  const activeController = await loadController();
  return activeController.startSession(options);
}

export async function stopSession() {
  if (!controller) return false;
  return controller.stopSession();
}

export function sendTextToModel(text) {
  return controller?.sendTextToModel?.(String(text || "")) || false;
}
