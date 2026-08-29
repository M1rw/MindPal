import { createSafeVoiceDiagnostic } from "../contracts/diagnostics.js";
import { createVoiceConsentController } from "./consent.js";
import { createVoiceDiagnostics } from "./diagnostics.js";
import { createVoiceViewModel } from "./view_model.js";

const ELEMENT_IDS = Object.freeze({
  overlay: "voice-live-overlay",
  trigger: "voice-btn",
  status: "voice-live-status",
  faceState: "voice-face-state-label",
  startup: "voice-startup-spinner",
  captions: "voice-transcript-panel",
  close: "voice-live-close",
  closeBottom: "voice-live-close-bottom",
  ccToggle: "voice-cc-toggle",
  muteToggle: "voice-mute-toggle",
  muteLabel: "voice-mute-label",
  consent: "voice-consent-panel",
  consentAllow: "voice-consent-allow",
  consentDecline: "voice-consent-decline",
  diagnostic: "voice-safe-diagnostics",
});

const EVENT_NAMES = Object.freeze({
  setup_complete: "setup_complete",
  interrupted: "interrupted",
  playback_scheduled: "playback_snapshot",
  playback_drained: "playback_drained",
  provider_error: "error",
  stop_requested: "session_stopped",
});

export function createVoiceController({
  documentRef = globalThis.document,
  getFeatureState,
  getReleaseDecision,
  createSession,
  getDiagnosticsEnabled = () => false,
  onUnavailable = () => {},
} = {}) {
  const consent = createVoiceConsentController({ onChange: () => render() });
  const diagnostics = createVoiceDiagnostics();
  let session = null;
  let sessionState = { state: "IDLE", generation: 0, setupComplete: false, errorCode: null };
  let playbackSnapshot = { activeSourceCount: 0, queueDepthMs: 0 };
  let captureState = "IDLE";
  let featureState = null;
  let releaseDecision = null;
  let bound = false;
  let captionsVisible = true;

  function bind() {
    if (bound || !documentRef) return;
    bound = true;
    element("trigger")?.addEventListener("click", handleTrigger);
    element("close")?.addEventListener("click", () => void endSession("user_close"));
    element("closeBottom")?.addEventListener("click", () => void endSession("user_close"));
    element("consentAllow")?.addEventListener("click", () => void allowMicrophone());
    element("consentDecline")?.addEventListener("click", () => declineMicrophone());
    element("ccToggle")?.addEventListener("click", toggleCaptions);
    element("muteToggle")?.addEventListener("click", toggleMute);
    syncAvailability();
  }

  function syncAvailability() {
    featureState = typeof getFeatureState === "function" ? getFeatureState("voice.live_v4") : null;
    releaseDecision = typeof getReleaseDecision === "function" ? getReleaseDecision(featureState) : null;
    render();
  }

  function handleTrigger() {
    if (!isAllowed()) {
      onUnavailable({ code: "voice_preview_unavailable" });
      return;
    }
    openOverlay();
  }

  function openOverlay() {
    const overlay = element("overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    overlay.classList.add("opacity-100", "pointer-events-auto");
    overlay.classList.remove("opacity-0", "pointer-events-none");
    render();
  }

  async function allowMicrophone() {
    if (!isAllowed() || typeof createSession !== "function") {
      onUnavailable({ code: "voice_preview_unavailable" });
      return;
    }
    consent.allow();
    try {
      session = createSession({
        onStateChange: handleSessionState,
        onFact: handleFact,
        onTranscript: handleTranscript,
        onError: handleSessionError,
      });
      await session.start();
    } catch (error) {
      handleSessionError({ code: safeCode(error?.code, "session_start_failed") });
    }
  }

  function declineMicrophone() {
    consent.decline();
    closeOverlay();
  }

  async function endSession(reason) {
    try {
      await session?.stop?.(reason);
    } catch (error) {
      handleSessionError({ code: "session_stop_failed" });
    }
    session = null;
    consent.reset();
    sessionState = { state: "IDLE", generation: 0, setupComplete: false, errorCode: null };
    playbackSnapshot = { activeSourceCount: 0, queueDepthMs: 0 };
    diagnostics.reset();
    clearCaptions();
    closeOverlay();
  }

  function handleSessionState(nextState) {
    sessionState = nextState || sessionState;
    diagnostics.record({
      event: eventNameForState(sessionState.state),
      state: sessionState.state,
      generation: sessionState.generation,
      errorCode: sessionState.errorCode,
    });
    render();
  }

  function handleFact(fact) {
    if (!fact || typeof fact.type !== "string") return;
    if (fact.type === "playback_scheduled") playbackSnapshot = { activeSourceCount: 1, queueDepthMs: fact.queueDepthMs || 0 };
    if (fact.type === "playback_drained") playbackSnapshot = { activeSourceCount: 0, queueDepthMs: 0 };
    diagnostics.record({
      event: EVENT_NAMES[fact.type] || "unknown",
      state: sessionState.state,
      generation: fact.generation,
      queueDepthMs: fact.queueDepthMs,
      activeSources: playbackSnapshot.activeSourceCount,
      errorCode: fact.code,
    });
    render();
  }

  function handleTranscript(fact) {
    if (!captionsVisible || fact?.type !== "output_transcript" || typeof fact.text !== "string") return;
    appendCaption(fact.text);
  }

  function handleSessionError(error) {
    sessionState = { ...sessionState, state: "ERROR", errorCode: safeCode(error?.code, "session_failed") };
    diagnostics.record({ event: "error", state: "ERROR", errorCode: sessionState.errorCode });
    render();
  }

  function toggleCaptions() {
    captionsVisible = !captionsVisible;
    const button = element("ccToggle");
    button?.setAttribute("aria-pressed", String(captionsVisible));
    button?.setAttribute("title", captionsVisible ? "Hide captions" : "Show captions");
    element("captions")?.classList.toggle("opacity-0", !captionsVisible);
  }

  function toggleMute() {
    onUnavailable({ code: "microphone_mute_not_available" });
  }

  function render() {
    const model = createVoiceViewModel({
      featureState,
      releaseDecision,
      sessionState,
      captureState,
      playbackSnapshot,
      consentState: consent.getState(),
    });
    const trigger = element("trigger");
    trigger?.toggleAttribute("disabled", !model.enabled);
    trigger?.setAttribute("aria-disabled", String(!model.enabled));
    trigger?.setAttribute("aria-label", model.enabled ? "Start voice conversation" : "Voice input unavailable");
    trigger?.setAttribute("title", model.enabled ? "Start voice conversation" : "Voice is unavailable");
    setText("status", model.status);
    setText("faceState", model.status);
    element("startup")?.classList.toggle("hidden", !["REQUESTING_TOKEN", "CONNECTING", "SETUP_WAIT"].includes(model.sessionState));
    element("consent")?.classList.toggle("hidden", !model.showConsent);
    const muteToggle = element("muteToggle");
    muteToggle?.toggleAttribute("disabled", true);
    muteToggle?.setAttribute("aria-disabled", "true");
    const diagnostic = element("diagnostic");
    if (diagnostic) {
      diagnostic.classList.toggle("hidden", !getDiagnosticsEnabled());
      diagnostic.textContent = getDiagnosticsEnabled() ? formatDiagnostic(diagnostics.getSnapshot()) : "";
    }
    if (model.errorCode) setText("status", `Voice unavailable (${model.errorCode})`);
  }

  function isAllowed() {
    return featureState?.enabled === true && releaseDecision?.allowed === true;
  }

  function closeOverlay() {
    const overlay = element("overlay");
    if (!overlay) return;
    overlay.classList.add("opacity-0", "pointer-events-none", "hidden");
    overlay.classList.remove("opacity-100", "pointer-events-auto");
  }

  function clearCaptions() {
    const captions = element("captions");
    if (captions) captions.replaceChildren();
  }

  function appendCaption(text) {
    const captions = element("captions");
    if (!captions) return;
    const paragraph = documentRef.createElement("p");
    paragraph.className = "voice-caption-line";
    paragraph.textContent = text.slice(0, 2_000);
    captions.append(paragraph);
    captions.scrollTop = captions.scrollHeight;
  }

  function setText(name, value) {
    const target = element(name);
    if (target) target.textContent = String(value || "");
  }

  function element(name) {
    const id = ELEMENT_IDS[name];
    return id ? documentRef?.getElementById(id) : null;
  }

  return Object.freeze({
    bind,
    syncAvailability,
    endSession,
    getConsentState: () => consent.getState(),
    getDiagnostics: diagnostics.getSnapshot,
  });
}

export const createVoiceLayer6Controller = createVoiceController;

function eventNameForState(state) {
  if (state === "SETUP_WAIT") return "setup_sent";
  if (state === "LISTENING") return "setup_complete";
  if (state === "ERROR") return "error";
  return "session_created";
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function formatDiagnostic(snapshot) {
  return Object.entries(createSafeVoiceDiagnostic(snapshot))
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}
