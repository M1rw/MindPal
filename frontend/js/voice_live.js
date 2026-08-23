// frontend/js/voice_live.js — UI orchestrator for voice calls

import { refreshIcons } from "./utils/icons.js";
import { getAppCheckToken, getIdToken } from "./auth.js";
import {
  startSession,
  stopSession,
  setMuted,
  getMicMuted,
  getAiSpeaking,
  setSpeakerMuted,
  getSpeakerMuted,
  getTranscriptSnapshot,
} from "./voice_session.js";
import {
  startVoiceFace,
  stopVoiceFace,
  feedVoiceFaceMicLevel,
  feedVoiceFaceAiLevel,
  setVoiceFaceState,
  setVoiceFaceDiagnostic,
} from "./voice/voice_face_visualizer.js";

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
// The canonical runtime releases captions on actual playback events; this UI
// keeps only the currently visible line and the current turn boundary.
let currentCaption = null;
let captionTurnComplete = false;
let captionScrollFrame = null;
let captionSourceText = "";
let captionTurnSerial = 0;

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
      if (panel) {
        panel.style.opacity = ccVisible ? "1" : "0";
        panel.style.visibility = ccVisible ? "visible" : "hidden";
        panel.setAttribute("aria-hidden", String(!ccVisible));
      }
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
  captionTurnComplete = false;
  captionTurnSerial += 1;
  captionSourceText = "";
  if (captionScrollFrame) cancelAnimationFrame(captionScrollFrame);
  captionScrollFrame = null;
  backgroundTaskCount = 0;

  // Prepare UI
  const overlay = document.getElementById("voice-live-overlay");
  const statusEl = document.getElementById("voice-live-status");
  const panel = document.getElementById("voice-transcript-panel");

  if (panel) {
    panel.innerHTML = "";
    panel.style.opacity = "1";
    panel.style.visibility = "visible";
    panel.style.display = "";
    panel.setAttribute("aria-hidden", "false");
  }
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

  // Preserve a mute request made while the provider is still connecting.
  updateMicUI(getMicMuted());
  startVoiceFace({
    isMicMuted: getMicMuted,
    isAiSpeaking: getAiSpeaking,
  });
  setVoiceFaceState({
    phase: "connecting",
    isMicMuted: getMicMuted(),
    isAiSpeaking: getAiSpeaking(),
    isSpeakerMuted: getSpeakerMuted(),
    error: false,
  });

  try {
    // Get auth token for authenticated API calls
    const token = await getIdToken().catch(() => null);

    // Voice requires authentication — show friendly message in guest mode
    if (!token) {
      setVoiceFaceState({ phase: "error", error: true });
      if (statusEl) statusEl.textContent = "Sign in to use voice calls";
      setTimeout(stopLiveVoice, 3000);
      return;
    }

    // Start audio session
    await startSession({
      contextProvider,
      onTranscript: handleTranscript,
      onCaption: handleCanonicalCaptionRelease,
      onAudioState: handleAudioState,
      onSessionEnd: handleSessionEnd,
      onTurnComplete: handleTurnComplete,
      onBackgroundTask: handleBackgroundTask,
      onDiagnostic: handleVoiceDiagnostic,
      onVolume: handleVoiceVolume,
      token,
      getAuthToken: () => getIdToken(),
      refreshAuthToken: () => getIdToken({ forceRefresh: true }),
      getAppCheckToken: () => getAppCheckToken(),
      refreshAppCheckToken: () => getAppCheckToken({ forceRefresh: true }),
    });

    // Keep the connection-only spinner visible until the live session itself
    // emits its setup-complete Listening state through handleAudioState().
  } catch (error) {
    setVoiceFaceState({ phase: "error", error: true });
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
  clearCaptionReleaseQueue();

  const canonicalTranscript = getTranscriptSnapshot?.() || {};
  const persistedUserTranscript = canonicalTranscript.userTranscript || userTranscript;
  const persistedAiTranscript = canonicalTranscript.aiTranscript || aiTranscript;
  stopSession();
  stopVoiceFace();

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
  if (!isIncognito && onChatSyncCallback && (persistedUserTranscript.trim() || persistedAiTranscript.trim())) {
    const endTime = new Date();
    onChatSyncCallback({
      userTranscript: persistedUserTranscript.trim(),
      aiTranscript: persistedAiTranscript.trim(),
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

function isSameOrCumulativeCaption(previous, next) {
  const prior = String(previous || "").trim();
  const current = String(next || "").trim();
  return Boolean(prior && current && (prior === current || prior.startsWith(current) || current.startsWith(prior)));
}

function renderCaptionText(caption, rawText) {
  const value = String(rawText || "");
  caption.dir = "auto";
  caption.setAttribute("aria-label", value);
  caption.textContent = value;
}

function isInternalCaptionText(text) {
  return /\[(?:INTERNAL\s+(?:RESPONSE\s+PLAN|VOICE\s+OPERATION|LISTENING\s+PRESENCE)|USER-FACING\s+RESPONSE\s+PLAN)\b[^\]]*\]/i.test(String(text || ""));
}

function clearCaptionReleaseQueue({ preserveSource = false } = {}) {
  captionTurnSerial += 1;
  if (!preserveSource) {
    captionSourceText = "";
    currentCaption = null;
  }
}

function handleCanonicalCaptionRelease(text) {
  const cleaned = String(text || "").replace(/<noise>/gi, "").trim();
  if (!cleaned || isInternalCaptionText(cleaned) || !isLiveActive) return;
  if (captionTurnComplete || !currentCaption) {
    currentCaption = createAiCaption();
    captionTurnComplete = false;
  }
  if (!currentCaption || captionSourceText === cleaned) return;
  captionSourceText = cleaned;
  currentCaption.dataset.rawText = cleaned;
  renderCaptionText(currentCaption, cleaned);
  scrollTranscript();
}

export function shouldPreserveCaptionQueueOnUserTranscript({ providerInterrupted = false } = {}) {
  return providerInterrupted !== true;
}

function handleTranscript(type, text) {
  if (!text) return;
  const cleaned = String(text).replace(/<noise>/gi, "").trim();
  if (!cleaned || isInternalCaptionText(cleaned)) return;
  if (type === "user") userTranscript = appendTranscriptChunk(userTranscript, cleaned);
  if (type === "ai") aiTranscript = appendTranscriptChunk(aiTranscript, cleaned);
}

function handleVoiceVolume({ rms = 0, aiLevel = 0, muted = false } = {}) {
  feedVoiceFaceMicLevel({ rms, muted });
  feedVoiceFaceAiLevel(aiLevel);
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

function handleVoiceDiagnostic(event = {}) {
  console.debug("[MindPal Voice][diagnostic]", event);
  if (["voice.socket-error", "voice.socket-closed", "provider.error", "provider.closed"].includes(event?.type)) console.warn("[MindPal Voice]", event);
  setVoiceFaceDiagnostic(event);
  if (event?.type === "voice.playback.flushed" && event.reason) {
    clearCaptionReleaseQueue({ preserveSource: true });
    captionTurnComplete = true;
  }
  const diagnosticStatus = document.getElementById("voice-live-status");
  if (!diagnosticStatus) return;
  if (event?.type === "voice.socket-open") diagnosticStatus.textContent = event.setupSent ? "Configuring Voice…" : "Voice socket opened";
  else if (event?.type === "voice.socket-error" || event?.type === "voice.socket-closed") diagnosticStatus.textContent = `Voice transport failed${event.code ? ` (${event.code})` : ""} — please try again`;
  else if (event?.type === "voice.provider-ready-timeout" || event?.type === "provider.error" || event?.type === "provider.closed") diagnosticStatus.textContent = "Voice connection failed — please try again";
}

function handleAudioState({
  phase,
  isAiSpeaking: aiSpeaking,
  isMicMuted: muted,
  palette,
  interactionTag = "",
  faceExpression,
  faceTheme,
  faceState,
} = {}) {
  const overlay = document.getElementById("voice-live-overlay");
  lastAudioProjection = {
    phase: phase || "idle",
    isAiSpeaking: Boolean(aiSpeaking),
    isMicMuted: Boolean(muted),
    interactionTag,
  };

  if (overlay) overlay.dataset.voicePhase = phase || "idle";
  if (typeof muted === "boolean") updateMicUI(muted);
  setVoiceFaceState({
    phase: phase || "idle",
    isAiSpeaking: Boolean(aiSpeaking),
    isMicMuted: Boolean(muted),
    isSpeakerMuted: getSpeakerMuted(),
    interactionTag,
    backgroundTaskActive: backgroundTaskCount > 0,
    error: false,
    faceExpression,
    faceTheme,
    ...faceState,
  });
  renderMinimalVoiceStatus();
}

function handleBackgroundTask({ status } = {}) {
  if (status === "started") backgroundTaskCount += 1;
  if (["ready", "failed", "discarded"].includes(status)) {
    backgroundTaskCount = Math.max(0, backgroundTaskCount - 1);
  }
  if (isLiveActive) {
    setVoiceFaceState({ backgroundTaskActive: backgroundTaskCount > 0 });
    renderMinimalVoiceStatus();
  }
}

function handleSessionEnd() {
  if (isLiveActive) stopLiveVoice();
}

function handleTurnComplete() {
  // Do not remove the completed caption: it is the only visible transcript
  // until the next response starts. Mark the boundary and create the next DOM
  // node lazily when the next AI transcript actually arrives.
  captionTurnComplete = true;
}

// ═══════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════

function createAiCaption() {
  const panel = document.getElementById("voice-transcript-panel");
  if (!panel) return null;
  if (ccVisible) {
    panel.style.opacity = "1";
    panel.style.visibility = "visible";
    panel.style.display = "";
    panel.setAttribute("aria-hidden", "false");
  }
  panel.querySelectorAll(".voice-caption--active").forEach((caption) => caption.classList.remove("voice-caption--active"));
  const caption = document.createElement("p");
  caption.className = "voice-caption voice-caption--active";
  caption.setAttribute("aria-atomic", "true");
  caption.setAttribute("dir", "auto");
  caption.dataset.rawText = "";
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
