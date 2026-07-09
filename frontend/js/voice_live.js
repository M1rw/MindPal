// frontend/js/voice_live.js — UI orchestrator for voice calls

import { refreshIcons } from "./utils/icons.js";
import { getIdToken } from "./auth.js";
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

// Transcript bubble tracking
let lastSpeaker = null;
let currentBubble = null;

// ═══════════════════════════════════════════════════════════════
// Init (called once on page load)
// ═══════════════════════════════════════════════════════════════

export function initLiveVoice({ onChatSync } = {}) {
  onChatSyncCallback = onChatSync;

  document.getElementById("voice-live-close")?.addEventListener("click", stopLiveVoice);
  document.getElementById("voice-live-close-bottom")?.addEventListener("click", stopLiveVoice);

  // CC toggle
  const ccBtn = document.getElementById("voice-cc-toggle");
  if (ccBtn) {
    ccBtn.addEventListener("click", () => {
      ccVisible = !ccVisible;
      const panel = document.getElementById("voice-transcript-panel");
      if (panel) panel.style.opacity = ccVisible ? "1" : "0";
    });
  }

  // Incognito toggle
  const incognitoBtn = document.getElementById("voice-incognito-toggle");
  if (incognitoBtn) {
    incognitoBtn.addEventListener("click", () => {
      isIncognito = !isIncognito;
      const icon = incognitoBtn.querySelector("[data-lucide]");
      if (icon) icon.setAttribute("data-lucide", isIncognito ? "eye-off" : "eye");
      refreshIcons();

      const statusEl = document.getElementById("voice-live-status");
      if (statusEl) {
        const prev = statusEl.textContent;
        statusEl.textContent = isIncognito ? "Incognito on" : "Incognito off";
        setTimeout(() => {
          if (statusEl.textContent.startsWith("Incognito")) statusEl.textContent = prev;
        }, 1500);
      }
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
  callStartTime = new Date();
  lastSpeaker = null;
  currentBubble = null;

  // Prepare UI
  const overlay = document.getElementById("voice-live-overlay");
  const statusEl = document.getElementById("voice-live-status");
  const panel = document.getElementById("voice-transcript-panel");

  if (panel) { panel.innerHTML = ""; panel.style.opacity = "1"; }
  if (statusEl) statusEl.textContent = "Connecting…";

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
      onVolume: feedVolume,
      token,
    });

    // Wire up visualizer with session analysers
    const { micAnalyser, aiAnalyser } = getSessionState();
    startVisualizer({
      isMicMuted: getMicMuted,
      isAiSpeaking: getAiSpeaking,
    });
    setAnalysers({ mic: micAnalyser, ai: aiAnalyser });

    if (statusEl) statusEl.textContent = "Listening…";
    setPalette("listen");
  } catch (error) {
    console.error("Failed to start Live Voice", error);
    if (statusEl) statusEl.textContent = "Error: " + (error.message || "Failed to connect");
    setTimeout(stopLiveVoice, 3000);
  }
}

// ═══════════════════════════════════════════════════════════════
// Stop
// ═══════════════════════════════════════════════════════════════

export function stopLiveVoice() {
  if (!isLiveActive) return;
  isLiveActive = false;

  stopSession({ full: true });
  stopVisualizer();

  // Hide overlay with transition
  const overlay = document.getElementById("voice-live-overlay");
  overlay.classList.add("opacity-0");
  overlay.classList.remove("pointer-events-auto");
  setTimeout(() => overlay.classList.add("hidden"), 500);

  // Sync to chat (unless incognito)
  if (!isIncognito && onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
    const endTime = new Date();
    onChatSyncCallback({
      userTranscript: userTranscript.trim(),
      aiTranscript: aiTranscript.trim(),
      startTime: callStartTime?.toISOString() || endTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: callStartTime ? endTime - callStartTime : 0,
      incognito: false,
    });
  }

  // Reset incognito for next call
  isIncognito = false;
  const incognitoBtn = document.getElementById("voice-incognito-toggle");
  if (incognitoBtn) {
    const icon = incognitoBtn.querySelector("[data-lucide]");
    if (icon) icon.setAttribute("data-lucide", "eye");
  }
}

// ═══════════════════════════════════════════════════════════════
// Callbacks from session
// ═══════════════════════════════════════════════════════════════

function handleTranscript(type, text) {
  if (!text) return;

  // Filter noise markers
  const cleaned = text.replace(/<noise>/gi, "");
  if (!cleaned?.trim()) return;

  // New speaker → new bubble
  if (lastSpeaker !== type || !currentBubble) {
    currentBubble = createBubble(type);
    lastSpeaker = type;
  }

  if (currentBubble) {
    currentBubble.textContent += cleaned;
  }

  if (type === "ai") aiTranscript += cleaned;
  else userTranscript += cleaned;

  scrollTranscript();
}

function handleAudioState({ isAiSpeaking: aiSpeaking, isMicMuted: muted, palette }) {
  const statusEl = document.getElementById("voice-live-status");

  setPalette(palette);

  if (aiSpeaking) {
    if (statusEl) statusEl.textContent = "MindPal is speaking…";
  } else {
    if (statusEl) statusEl.textContent = muted ? "Muted" : "Listening…";
  }
}

function handleSessionEnd() {
  if (isLiveActive) stopLiveVoice();
}

function handleTurnComplete() {
  // Force a new bubble for the next transcript message
  currentBubble = null;
}

// ═══════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════

function createBubble(type) {
  const panel = document.getElementById("voice-transcript-panel");
  if (!panel) return null;
  const div = document.createElement("div");
  div.className = `voice-msg voice-msg-${type}`;
  panel.appendChild(div);
  return div;
}

function scrollTranscript() {
  const panel = document.getElementById("voice-transcript-panel");
  if (panel) panel.scrollTop = panel.scrollHeight;
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
