// MindPal production voice facade.

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

// Keep the Voice runtime out of the main application bundle, but load it through
// the browser's native module-script pipeline. This avoids the production-only
// failure mode where import() reports a generic "failed to fetch dynamically
// imported module" error even though the asset itself is reachable.
const VOICE_RUNTIME_PATH = "/voice/assets/runtime.js";
// Change this value whenever the runtime contract changes so a browser cannot
// reuse a previous deployment's module graph or lifecycle implementation.
const VOICE_RUNTIME_VERSION = "voice-runtime-ddf626a";
const VOICE_RUNTIME_SCRIPT_ATTRIBUTE = "data-mindpal-voice-runtime";

function getRuntimeFactory() {
  const win = globalThis.window;
  return win?.__MINDPAL_VOICE_RUNTIME__?.createVoiceController;
}

function createControllerFromGlobal() {
  const factory = getRuntimeFactory();
  if (typeof factory !== "function") {
    throw new Error("MindPal Voice runtime did not expose a controller factory");
  }
  controller = factory();
  return controller;
}

async function loadController() {
  if (controller) return controller;
  if (!controllerPromise) {
    controllerPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector(
        `script[${VOICE_RUNTIME_SCRIPT_ATTRIBUTE}]`
      );
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
      script.setAttribute(VOICE_RUNTIME_SCRIPT_ATTRIBUTE, "true");
      const runtimeUrl = new URL(VOICE_RUNTIME_PATH, document.baseURI);
      runtimeUrl.searchParams.set("v", VOICE_RUNTIME_VERSION);
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
        reject(new Error(`MindPal Voice runtime failed to load: ${runtimeUrl.href}`));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      controllerPromise = null;
      throw error;
    });
  }
  return controllerPromise;
}

export function preloadVoiceRuntime() {
  void loadController().catch(() => undefined);
}

export function getSessionState() {
  return controller?.getSessionState?.() || EMPTY_STATE;
}

export function getSessionDebugReport() {
  return controller?.getSessionDebugReport?.() || null;
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

export function injectAudioFrame(frame) {
  return controller?.injectAudioFrame?.(frame) || false;
}

export function endAudioStream() {
  return controller?.endAudioStream?.() || false;
}

export function setNativeCaptureSuppressed(suppressed) {
  controller?.setNativeCaptureSuppressed?.(Boolean(suppressed));
}
