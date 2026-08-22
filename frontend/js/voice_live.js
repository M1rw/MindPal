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
  getTranscriptSnapshot,
} from "./voice_session.js";
import {
  startVoiceFace,
  stopVoiceFace,
  feedVoiceFaceMicLevel,
  setVoiceFaceState,
  setVoiceFaceDiagnostic,
  setVoiceFaceAnalysers,
} from "./voice/voice_face_visualizer.js";
import { planPacedCaptionSegments } from "./voice/caption_sync_policy.js";

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
let captionTurnComplete = false;
let captionScrollFrame = null;
let captionReleaseTimer = null;
let captionFallbackTimer = null;
let captionQueue = [];
let captionBufferedText = "";
let captionPendingText = "";
// The complete assistant response is rendered immediately. These offsets only
// control the moving spoken-word highlight, so transcript visibility never
// waits for the pacing queue.
let captionSourceText = "";
let captionNextReleaseAtMs = 0;
let captionAudioStartAtMs = 0;
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
  captionQueue = [];
  captionBufferedText = "";
  captionPendingText = "";
  captionSourceText = "";
  captionNextReleaseAtMs = 0;
  captionAudioStartAtMs = 0;
  if (captionReleaseTimer) clearTimeout(captionReleaseTimer);
  if (captionFallbackTimer) clearTimeout(captionFallbackTimer);
  captionReleaseTimer = null;
  captionFallbackTimer = null;
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
      onAudioState: handleAudioState,
      onSessionEnd: handleSessionEnd,
      onTurnComplete: handleTurnComplete,
      onBackgroundTask: handleBackgroundTask,
      onDiagnostic: handleVoiceDiagnostic,
      onVolume: feedVoiceFaceMicLevel,
      token,
      refreshAuthToken: () => getIdToken({ forceRefresh: true }),
      getAppCheckToken: () => getAppCheckToken(),
      refreshAppCheckToken: () => getAppCheckToken({ forceRefresh: true }),
    });

    // Attach the real session analysers after the provider/capture layers exist.
    const { micAnalyser, aiAnalyser } = getSessionState();
    setVoiceFaceAnalysers({ mic: micAnalyser, ai: aiAnalyser });

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

function detectCaptionDirection(text) {
  const value = String(text || "");
  const arabicIndex = value.search(/[\u0590-\u08FF]/);
  const latinIndex = value.search(/[A-Za-z]/);
  if (arabicIndex >= 0 && (latinIndex < 0 || arabicIndex < latinIndex)) return "rtl";
  return "ltr";
}

function isolateMixedScriptRuns(text, direction) {
  const value = String(text || "");
  // Unicode directional isolates keep embedded names, URLs, numbers, and
  // translated phrases from reordering the surrounding Arabic/English line.
  if (direction === "rtl") {
    return value.replace(/([A-Za-z][A-Za-z0-9@._:/+%#?=&-]*(?:[ ]+[A-Za-z0-9@._:/+%#?=&-]+)*)/g, (_, match) => `${String.fromCodePoint(0x2066)}${match}${String.fromCodePoint(0x2069)}`);
  }
  return value.replace(/[\u0590-\u08FF][\u0590-\u08FF0-9\u0660-\u0669@._:/+%#?=&-]*(?:[ ]+[\u0590-\u08FF0-9\u0660-\u0669@._:/+%#?=&-]+)*/g, (match) => `${String.fromCodePoint(0x2067)}${match}${String.fromCodePoint(0x2069)}`);
}

function renderCaptionText(caption, rawText) {
  const value = String(rawText || "");
  caption.dir = detectCaptionDirection(value);
  caption.setAttribute("aria-label", value);
  caption.replaceChildren(document.createTextNode(isolateMixedScriptRuns(value, caption.dir)));
}

function isInternalCaptionText(text) {
  return /\[(?:INTERNAL\s+(?:RESPONSE\s+PLAN|VOICE\s+OPERATION|LISTENING\s+PRESENCE)|USER-FACING\s+RESPONSE\s+PLAN)\b[^\]]*\]/i.test(String(text || ""));
}

function clearCaptionReleaseQueue({ preserveSource = false } = {}) {
  captionTurnSerial += 1;
  if (captionReleaseTimer) clearTimeout(captionReleaseTimer);
  if (captionFallbackTimer) clearTimeout(captionFallbackTimer);
  captionReleaseTimer = null;
  captionFallbackTimer = null;
  captionQueue = [];
  captionPendingText = "";
  captionNextReleaseAtMs = 0;
  captionAudioStartAtMs = 0;
  if (!preserveSource) {
    captionBufferedText = "";
    captionSourceText = "";
  }
}

function scheduleCaptionRelease() {
  if (captionReleaseTimer || !captionQueue.length) return;
  const serial = captionTurnSerial;
  const release = () => {
    captionReleaseTimer = null;
    if (serial !== captionTurnSerial || !isLiveActive) return;
    const now = Date.now();
    const next = captionQueue[0];
    if (!next) return;
    if (next.startTime * 1000 > now) {
      captionReleaseTimer = setTimeout(release, Math.max(0, next.startTime * 1000 - now));
      return;
    }
    captionQueue.shift();
    renderAiCaptionChunk(next.text);
    scheduleCaptionRelease();
  };
  release();
}

function queuePacedCaptionTranscript(text, { audioStartMs = 0 } = {}) {
  const cleaned = String(text || "").replace(/<noise>/gi, "").trim();
  if (!cleaned || isInternalCaptionText(cleaned)) return false;
  const merged = appendTranscriptChunk(captionBufferedText, cleaned);
  const delta = merged.startsWith(captionBufferedText) ? merged.slice(captionBufferedText.length) : cleaned;
  captionBufferedText = merged;
  if (!delta.trim()) return false;

  const nowMs = Date.now();
  const startMs = Math.max(nowMs, Number(audioStartMs) || 0, captionNextReleaseAtMs);
  const segments = planPacedCaptionSegments({
    text: delta,
    audioStartTime: startMs / 1000,
    nextCaptionTime: captionNextReleaseAtMs / 1000,
    now: nowMs / 1000,
  });
  if (!segments.length) return false;
  captionQueue.push(...segments);
  const last = segments[segments.length - 1];
  captionNextReleaseAtMs = last.startTime * 1000 + last.duration * 1000;
  scheduleCaptionRelease();
  return true;
}

function flushPendingCaptionText({ audioStartMs = 0 } = {}) {
  if (!captionPendingText) return false;
  const pending = captionPendingText;
  captionPendingText = "";
  return queuePacedCaptionTranscript(pending, { audioStartMs });
}

function armCaptionFallback() {
  if (captionFallbackTimer || !captionPendingText) return;
  const serial = captionTurnSerial;
  captionFallbackTimer = setTimeout(() => {
    captionFallbackTimer = null;
    if (serial !== captionTurnSerial || !isLiveActive || captionAudioStartAtMs) return;
    flushPendingCaptionText({ audioStartMs: Date.now() });
  }, 1_800);
}

function handleMainPlaybackStarted() {
  captionAudioStartAtMs ||= Date.now();
  flushPendingCaptionText({ audioStartMs: captionAudioStartAtMs });
}

function renderAiCaptionChunk(cleaned) {
  if (!cleaned || isInternalCaptionText(cleaned)) return;
  const panel = document.getElementById("voice-transcript-panel");
  if (panel && ccVisible) {
    panel.style.opacity = "1";
    panel.style.visibility = "visible";
    panel.style.display = "";
    panel.setAttribute("aria-hidden", "false");
  }
  if (!currentCaption || captionTurnComplete) {
    currentCaption = createAiCaption();
    captionTurnComplete = false;
  }
  if (!currentCaption) return;

  if (!captionSourceText.trim()) return;
  renderCaptionText(currentCaption, captionSourceText);
  scrollTranscript();
}

export function shouldPreserveCaptionQueueOnUserTranscript({ providerInterrupted = false } = {}) {
  // Input transcription is not authoritative proof that the model was
  // interrupted: native-audio echo, stale worklet frames, and partial VAD
  // updates can arrive while an answer is still being released. The provider's
  // interrupted event is the authoritative boundary for discarding queued AI
  // captions. Preserving here prevents a valid caption from disappearing before
  // the 1.8s fallback or the main-audio playback-start signal can render it.
  return providerInterrupted !== true;
}

function handleTranscript(type, text) {
  if (!text) return;
  console.debug("[MindPal Voice][caption]", { type, text: String(text).slice(0, 240) });
  const cleaned = String(text).replace(/<noise>/gi, "");
  if (!cleaned.trim()) return;

  if (type === "user") {
    userTranscript = appendTranscriptChunk(userTranscript, cleaned);
    // Do not clear queued assistant captions here. Input transcription can be
    // an echoed/late partial while the assistant is still speaking. A genuine
    // barge-in is handled by PROVIDER_INTERRUPTED, which clears the queue at
    // the transport boundary and preserves the already-visible source text.
    if (!shouldPreserveCaptionQueueOnUserTranscript()) {
      clearCaptionReleaseQueue();
    }
    return;
  }
  if (type !== "ai" || isInternalCaptionText(cleaned)) return;

  if (captionTurnComplete) {
    // Gemini can deliver the final cumulative output-transcription snapshot
    // after turnComplete. It belongs to the completed response, not a new one.
    if (!isSameOrCumulativeCaption(captionSourceText, cleaned)) {
      clearCaptionReleaseQueue();
      currentCaption = null;
    }
    captionTurnComplete = false;
  }
  // Keep the complete visible response immediate. The pacing queue is retained
  // only for delivery ordering and never creates another caption node.
  aiTranscript = appendTranscriptChunk(aiTranscript, cleaned);
  const mergedSource = appendTranscriptChunk(captionSourceText, cleaned);
  if (mergedSource !== captionSourceText) {
    captionSourceText = mergedSource;
    if (!currentCaption) currentCaption = createAiCaption();
    if (currentCaption) {
      currentCaption.dataset.rawText = captionSourceText;
      renderCaptionText(currentCaption, captionSourceText);
      scrollTranscript();
    }
  }
  captionPendingText = appendTranscriptChunk(captionPendingText, cleaned);
  if (captionAudioStartAtMs) flushPendingCaptionText({ audioStartMs: captionAudioStartAtMs });
  else armCaptionFallback();
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
  if (event?.type === "voice.playback.started" && event.audioClass === "main") handleMainPlaybackStarted();
  if (event?.type === "voice.playback.ended" && event.audioClass === "main" && !captionQueue.length && !captionPendingText) {
    captionAudioStartAtMs = 0;
    captionNextReleaseAtMs = 0;
    captionBufferedText = "";
  }
  if (event?.type === "voice.playback.flushed" && event.reason === "provider-interrupted") {
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
  caption.setAttribute("dir", "ltr");
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
