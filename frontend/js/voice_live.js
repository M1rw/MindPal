// frontend/js/voice_live.js — UI orchestrator for voice calls

import { refreshIcons } from "./utils/icons.js";
import { getAppCheckToken, getIdToken } from "./auth.js";
import {
  startSession,
  stopSession,
  setMuted,
  getMicMuted,
  getAiSpeaking,
  getSessionState,
  setSpeakerMuted,
  getSpeakerMuted,
} from "./voice_session.js";
import {
  startVisualizer,
  stopVisualizer,
  feedVolume,
  setPalette,
  setAnalysers,
} from "./voice_visualizer.js";

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let isLiveActive = false;
let userTranscript = "";
let aiTranscript = "";
let callStartTime = null;
let ccVisible = true;
let isIncognito = false;
let onChatSyncCallback = null;
let liveVoiceInitialized = false;
let backgroundTaskCount = 0;
let lastAudioProjection = { phase: "idle", isAiSpeaking: false, isMicMuted: false };

// AI-only caption tracking. User speech remains available for optional call
// history, but the live surface stays focused on MindPal's spoken captions.
let currentCaption = null;
let captionScrollFrame = null;

// ═══════════════════════════════════════════════════════════════
// Init (called once on page load)
// ═══════════════════════════════════════════════════════════════

export function initLiveVoice({ onChatSync } = {}) {
  onChatSyncCallback = onChatSync;
  if (liveVoiceInitialized) return;
  liveVoiceInitialized = true;

  document.getElementById("voice-live-close")?.addEventListener("click", stopLiveVoice);
  document.getElementById("voice-live-close-bottom")?.addEventListener("click", stopLiveVoice);

  // CC toggle
  const ccBtn = document.getElementById("voice-cc-toggle");
  if (ccBtn) {
    ccBtn.addEventListener("click", () => {
      ccVisible = !ccVisible;
      const panel = document.getElementById("voice-transcript-panel");
      if (panel) panel.style.opacity = ccVisible ? "1" : "0";
      ccBtn.setAttribute("aria-pressed", String(ccVisible));
      ccBtn.setAttribute("aria-label", ccVisible ? "Hide captions" : "Show captions");
      ccBtn.setAttribute("title", ccVisible ? "Hide captions" : "Show captions");
    });
  }

  // Call-history persistence toggle
  const incognitoBtn = document.getElementById("voice-incognito-toggle");
  if (incognitoBtn) {
    incognitoBtn.addEventListener("click", () => {
      isIncognito = !isIncognito;
      const icon = incognitoBtn.querySelector("[data-lucide]");
      if (icon) icon.setAttribute("data-lucide", isIncognito ? "eye-off" : "eye");
      refreshIcons();

      incognitoBtn.setAttribute("aria-pressed", String(isIncognito));
      incognitoBtn.setAttribute("aria-label", isIncognito ? "Private call is on" : "Do not add this call to chat history");
      incognitoBtn.setAttribute("title", isIncognito ? "Private call is on" : "Do not add this call to chat history");

    });
  }

  // Mute toggle
  const muteBtn = document.getElementById("voice-mute-toggle");
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const next = !getMicMuted();
      setMuted(next);
      updateMicUI(next);
    });
  }

  // Speaker toggle
  const speakerBtn = document.getElementById("voice-speaker-toggle");
  if (speakerBtn) {
    speakerBtn.addEventListener("click", () => {
      const next = !getSpeakerMuted();
      setSpeakerMuted(next);
      updateSpeakerUI(next);
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════

export async function startLiveVoice(contextProvider = null) {
  if (isLiveActive) return;
  isLiveActive = true;

  // Reset state
  userTranscript = "";
  aiTranscript = "";
  ccVisible = true;
  const ccBtn = document.getElementById("voice-cc-toggle");
  ccBtn?.setAttribute("aria-pressed", "true");
  ccBtn?.setAttribute("aria-label", "Hide captions");
  ccBtn?.setAttribute("title", "Hide captions");
  callStartTime = new Date();
  currentCaption = null;
  if (captionScrollFrame) cancelAnimationFrame(captionScrollFrame);
  captionScrollFrame = null;
  backgroundTaskCount = 0;

  // Prepare UI
  const overlay = document.getElementById("voice-live-overlay");
  const statusEl = document.getElementById("voice-live-status");
  const panel = document.getElementById("voice-transcript-panel");

  if (panel) { panel.innerHTML = ""; panel.style.opacity = "1"; }
  if (statusEl) statusEl.textContent = "Connecting…";

  if (!overlay) {
    isLiveActive = false;
    throw new Error("Voice overlay is missing from the page.");
  }

  overlay.dataset.voicePhase = "connecting";
  overlay.classList.remove("hidden");
  void overlay.offsetWidth;
  overlay.classList.remove("opacity-0");
  overlay.classList.add("pointer-events-auto");

  updateMicUI(false);

  try {
    // Get auth token for authenticated API calls
    const token = await getIdToken().catch(() => null);

    // Voice requires authentication — show friendly message in guest mode
    if (!token) {
      if (statusEl) statusEl.textContent = "Sign in to use voice calls";
      setTimeout(stopLiveVoice, 3000);
      return;
    }

    // Start audio session
    await startSession({
      contextProvider,
      onTranscript: handleTranscript,
      onAudioState: handleAudioState,
      onSessionEnd: handleSessionEnd,
      onTurnComplete: handleTurnComplete,
      onBackgroundTask: handleBackgroundTask,
      onDiagnostic: (event) => {
        console.warn("[MindPal Voice]", event);
        const diagnosticStatus = document.getElementById("voice-live-status");
        if (!diagnosticStatus) return;
        if (event?.type === "voice.socket-open") diagnosticStatus.textContent = event.setupSent ? "Configuring Voice…" : "Voice socket opened";
        else if (event?.type === "voice.socket-error" || event?.type === "voice.socket-closed") diagnosticStatus.textContent = `Voice transport failed${event.code ? ` (${event.code})` : ""} — please try again`;
        else if (event?.type === "voice.provider-ready-timeout" || event?.type === "provider.error" || event?.type === "provider.closed") diagnosticStatus.textContent = "Voice connection failed — please try again";
      },
      onVolume: feedVolume,
      token,
      refreshAuthToken: () => getIdToken({ forceRefresh: true }),
      getAppCheckToken: () => getAppCheckToken(),
      refreshAppCheckToken: () => getAppCheckToken({ forceRefresh: true }),
    });

    // Wire up visualizer with session analysers
    const { micAnalyser, aiAnalyser } = getSessionState();
    startVisualizer({
      isMicMuted: getMicMuted,
      isAiSpeaking: getAiSpeaking,
    });
    setAnalysers({ mic: micAnalyser, ai: aiAnalyser });

    // Keep the connection-only spinner visible until the live session itself
    // emits its setup-complete Listening state through handleAudioState().
  } catch (error) {
    console.error("Failed to start Live Voice", error);
    if (statusEl) statusEl.textContent = "Error: " + (error.message || "Failed to connect");
    // Keep the failure visible so the user can read the concrete cause and
    // manually close or retry instead of seeing an unexplained spinner vanish.
    setTimeout(stopLiveVoice, 30_000);
  }
}

// ═══════════════════════════════════════════════════════════════
// Stop
// ═══════════════════════════════════════════════════════════════

export function stopLiveVoice() {
  if (!isLiveActive) return;
  isLiveActive = false;

  stopSession();
  stopVisualizer();

  // Hide overlay with transition
  const overlay = document.getElementById("voice-live-overlay");
  if (overlay) {
    overlay.dataset.voicePhase = "idle";
    overlay.classList.add("opacity-0");
    overlay.classList.remove("pointer-events-auto");
    setTimeout(() => overlay.classList.add("hidden"), 500);
  }

  // A private-from-chat call still runs through the authenticated live session;
  // this control only blocks post-call transcript, memory, and cloud-chat persistence.
  if (!isIncognito && onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
    const endTime = new Date();
    onChatSyncCallback({
      userTranscript: userTranscript.trim(),
      aiTranscript: aiTranscript.trim(),
      startTime: callStartTime?.toISOString() || endTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: callStartTime ? endTime.getTime() - callStartTime.getTime() : 0,
      incognito: false,
    });
  }

  // Reset incognito for next call
  isIncognito = false;
  backgroundTaskCount = 0;
  const incognitoBtn = document.getElementById("voice-incognito-toggle");
  if (incognitoBtn) {
    const icon = incognitoBtn.querySelector("[data-lucide]");
    if (icon) icon.setAttribute("data-lucide", "eye");
    incognitoBtn.setAttribute("aria-pressed", "false");
  }
}

// ═══════════════════════════════════════════════════════════════
// Callbacks from session
// ═══════════════════════════════════════════════════════════════

function appendTranscriptChunk(existing, chunk) {
  const previous = String(existing || "");
  const next = String(chunk || "");
  if (!previous) return next;
  if (!next || previous.endsWith(next)) return previous;
  // Gemini transcription messages may be cumulative rather than deltas.
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  if (/\s$/.test(previous) || /^\s/.test(next) || /^[,.;:!?،؟]/.test(next)) return previous + next;
  return `${previous} ${next}`;
}

function detectCaptionDirection(text) {
  return /[\u0590-\u08FF]/.test(String(text || "")) ? "rtl" : "ltr";
}

function handleTranscript(type, text) {
  if (!text) return;

  // Filter noise markers
  const cleaned = text.replace(/<noise>/gi, "");
  if (!cleaned?.trim()) return;

  if (type === "user") {
    userTranscript = appendTranscriptChunk(userTranscript, cleaned);
    // Never display a duplicate user bubble. The next MindPal sentence begins a
    // fresh caption so the live visual remains unambiguously assistant-led.
    currentCaption = null;
    return;
  }
  if (type !== "ai") return;

  if (!currentCaption) currentCaption = createAiCaption();
  if (!currentCaption) return;

  const captionText = appendTranscriptChunk(currentCaption.textContent || "", cleaned);
  currentCaption.textContent = captionText;
  currentCaption.dir = detectCaptionDirection(captionText);
  aiTranscript = appendTranscriptChunk(aiTranscript, cleaned);
  scrollTranscript();
}

export function resolveMinimalVoiceStatus({ phase, isAiSpeaking: aiSpeaking } = {}) {
  // Product-facing state intentionally stays small. Runtime interaction tags and
  // telemetry remain available for diagnostics but never become user copy.
  if (["connecting", "recovering"].includes(phase)) return "Connecting…";
  if (phase === "inactive") return "Inactive";
  if (aiSpeaking || phase === "speaking") return "MindPal is speaking…";
  if (backgroundTaskCount > 0 || ["thinking", "preparing", "interrupting"].includes(phase)) return "Thinking…";
  return "Listening…";
}

function renderMinimalVoiceStatus() {
  const statusEl = document.getElementById("voice-live-status");
  if (statusEl) statusEl.textContent = resolveMinimalVoiceStatus(lastAudioProjection);
}

function handleAudioState({
  phase,
  isAiSpeaking: aiSpeaking,
  isMicMuted: muted,
  palette,
  interactionTag = "",
} = {}) {
  const overlay = document.getElementById("voice-live-overlay");
  lastAudioProjection = {
    phase: phase || "idle",
    isAiSpeaking: Boolean(aiSpeaking),
    isMicMuted: Boolean(muted),
    interactionTag,
  };

  if (overlay) overlay.dataset.voicePhase = phase || "idle";
  setPalette(palette);
  renderMinimalVoiceStatus();
}

function handleBackgroundTask({ status } = {}) {
  if (status === "started") backgroundTaskCount += 1;
  if (["ready", "failed", "discarded"].includes(status)) {
    backgroundTaskCount = Math.max(0, backgroundTaskCount - 1);
  }
  if (isLiveActive) renderMinimalVoiceStatus();
}

function handleSessionEnd() {
  if (isLiveActive) stopLiveVoice();
}

function handleTurnComplete() {
  // Force a fresh large caption for the next MindPal response.
  currentCaption = null;
}

// ═══════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════

function createAiCaption() {
  const panel = document.getElementById("voice-transcript-panel");
  if (!panel) return null;
  panel.querySelectorAll(".voice-caption--active").forEach((caption) => caption.classList.remove("voice-caption--active"));
  const caption = document.createElement("p");
  caption.className = "voice-caption voice-caption--active";
  caption.setAttribute("aria-atomic", "true");
  panel.appendChild(caption);
  return caption;
}

function scrollTranscript() {
  const panel = document.getElementById("voice-transcript-panel");
  if (!panel) return;
  if (captionScrollFrame) cancelAnimationFrame(captionScrollFrame);
  captionScrollFrame = requestAnimationFrame(() => {
    captionScrollFrame = null;
    panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
  });
}

function updateMicUI(muted) {
  const muteBtn = document.getElementById("voice-mute-toggle");
  const muteIcon = muteBtn?.querySelector("[data-lucide]");
  const muteLabel = document.getElementById("voice-mute-label");

  if (muteIcon) muteIcon.setAttribute("data-lucide", muted ? "mic-off" : "mic");
  if (muteLabel) muteLabel.textContent = muted ? "Unmute" : "Mute";

  refreshIcons();
}

function updateSpeakerUI(muted) {
  const btn = document.getElementById("voice-speaker-toggle");
  const icon = btn?.querySelector("[data-lucide]");
  const label = document.getElementById("voice-speaker-label");

  if (icon) icon.setAttribute("data-lucide", muted ? "phone" : "volume-2");
  if (label) label.textContent = muted ? "Phone" : "Speaker";

  refreshIcons();
}
