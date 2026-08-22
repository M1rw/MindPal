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

// Keep the V3 runtime out of the main application bundle, but load it through
// the browser's native module-script pipeline. This avoids the production-only
// failure mode where import() reports a generic "failed to fetch dynamically
// imported module" error even though the asset itself is reachable.
const V3_RUNTIME_PATH = "/voice-v3/assets/runtime.js";
// Keep this deployment-scoped so a cached runtime cannot reference a chunk
// hash from a previous immutable Vercel deployment.
const V3_RUNTIME_VERSION = "voice-v3-runtime-setup-null-20260822";
const V3_RUNTIME_SCRIPT_ATTRIBUTE = "data-mindpal-voice-v3-runtime";

function getRuntimeFactory() {
  return globalThis.window?.__MINDPAL_VOICE_V3_RUNTIME__?.createVoiceV3Controller;
}

function createControllerFromGlobal() {
  const factory = getRuntimeFactory();
  if (typeof factory !== "function") {
    throw new Error("MindPal Voice V3 runtime did not expose a controller factory");
  }
  controller = factory();
  return controller;
}

async function loadController() {
  if (controller) return controller;
  if (!controllerPromise) {
    controllerPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[${V3_RUNTIME_SCRIPT_ATTRIBUTE}]`);
      if (getRuntimeFactory()) {
        resolve(createControllerFromGlobal());
        return;
      }
      // A failed module script never fires another load event. Remove it so a
      // subsequent user attempt can make a clean request instead of hanging.
      existingScript?.remove();

      const script = document.createElement("script");
      script.type = "module";
      script.async = true;
      script.setAttribute(V3_RUNTIME_SCRIPT_ATTRIBUTE, "true");
      const runtimeUrl = new URL(V3_RUNTIME_PATH, document.baseURI);
      runtimeUrl.searchParams.set("v", V3_RUNTIME_VERSION);
      script.src = runtimeUrl.href;
      script.onload = () => {
        try {
          resolve(createControllerFromGlobal());
        } catch (error) {
          script.remove();
          reject(error);
        }
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`MindPal Voice V3 runtime failed to load: ${runtimeUrl.href}`));
      };
      document.head.appendChild(script);
    }).catch((error) => {
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
