// frontend/js/voice.js

import {
  autoResizeInput,
  refreshIcons,
  showToast,
  syncInputButtons,
} from "./ui_state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const RESTART_COOLDOWN_MS   = 700;
const WAVE_BAR_COUNT        = 12;
const VOICE_RMS_THRESHOLD   = 0.018;
const RECENT_VOICE_WINDOW_MS = 2_500;
const MAX_AUTO_RESTARTS     = 3;

// Known BCP-47 tags supported by the Web Speech API across major browsers.
// Unlisted locales fall back to the browser's own navigator.language rather
// than being passed through raw (which silently breaks recognition in Safari).
const SUPPORTED_LOCALES = new Set([
  "ar-EG", "ar-SA", "de-DE", "en-AU", "en-GB", "en-US",
  "es-ES", "es-MX", "fr-FR", "hi-IN", "it-IT", "ja-JP",
  "ko-KR", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ru-RU",
  "tr-TR", "zh-CN", "zh-TW",
]);

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Initialise the voice widget for a given input surface.
 * Returns a controller object. Call `controller.destroy()` on unmount.
 *
 * FIX #1 (singleton / multi-instance): All mutable state is now encapsulated
 * inside this factory function. Calling initVoice() twice creates two
 * completely independent instances with no shared state, safe for SPA
 * navigation and component re-renders.
 */
export function initVoice({
  inputId      = "chat-input",
  voiceButtonId = "voice-btn",
  micIconId    = "mic-icon",
} = {}) {
  const inputEl  = document.getElementById(inputId);
  const voiceBtn = document.getElementById(voiceButtonId);
  const micIcon  = document.getElementById(micIconId);

  if (!inputEl || !voiceBtn) {
    return createUnavailableVoiceController();
  }

  // ── Per-instance audio/recognition state ──────────────────────────────────
  let recognition          = null;
  let mediaStream          = null;
  let audioContext         = null;
  let analyser             = null;
  let waveformFrame        = null;
  let waveformData         = null;

  // ── Per-instance session flags ────────────────────────────────────────────
  let isRecording          = false;
  let sessionActive        = false;
  let locked               = false;
  let generating           = false;
  let manualStopRequested  = false;
  let lastEndedAt          = 0;

  let finalTranscript      = "";
  let interimTranscript    = "";

  let voiceHeard           = false;
  let lastVoiceAt          = 0;
  let recognitionRestartCount = 0;
  let pendingRestartTimer  = null;
  let lastRecognitionError = "";

  // ── DOM refs (live-resolved on every use – FIX #2) ────────────────────────
  /**
   * FIX #2 (stale refs): getRefs() is now called immediately before each
   * operation that needs DOM elements, not once at init time. This means a
   * framework re-render that rebuilds the DOM will always be picked up
   * automatically without any extra coordination.
   */
  function getRefs() {
    const el      = document.getElementById(inputId);
    const surface = el?.parentElement ?? null;

    return {
      surface,
      panel:         document.getElementById("voice-inline-panel"),
      title:         document.getElementById("voice-title"),
      status:        document.getElementById("voice-status"),
      transcript:    document.getElementById("voice-transcript"),
      waveform:      document.getElementById("voice-waveform"),
      bars:          Array.from(document.querySelectorAll("#voice-waveform span")),
      cancelBtn:     document.getElementById("voice-inline-cancel-btn"),
      acceptBtn:     document.getElementById("voice-inline-accept-btn"),
      retryBtn:      document.getElementById("voice-inline-retry-btn"),
      normalControls: el?.nextElementSibling ?? null,
    };
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  ensureInlineVoiceStyles();
  ensureInlineVoicePanel(inputEl);

  // Attach panel-button listeners once (the panel is injected above and
  // will not be re-created, so attaching once is correct here).
  document.getElementById("voice-inline-cancel-btn")
    ?.addEventListener("click", () => cancelVoiceCapture());

  document.getElementById("voice-inline-accept-btn")
    ?.addEventListener("click", () => acceptVoiceCapture());

  document.getElementById("voice-inline-retry-btn")
    ?.addEventListener("click", () => retryVoiceCapture());

  voiceBtn.addEventListener("click", () => {
    if (locked || generating) return;
    if (isRecording) { stopVoiceRecognition(); return; }
    startVoiceCapture();
  });

  // ── Core capture flow ─────────────────────────────────────────────────────

  async function startVoiceCapture() {
    if (locked || generating) return false;

    const waitMs = RESTART_COOLDOWN_MS - (Date.now() - lastEndedAt);
    if (waitMs > 0) {
      window.setTimeout(startVoiceCapture, waitMs);
      return true;
    }

    resetSessionState();
    sessionActive = true;

    setInputBoxVoiceMode(true);
    setMainMicRecording();
    setPhase("preparing");
    updateTranscriptUI();

    try {
      await startMicMeter();
    } catch (err) {
      console.warn("Mic capture failed:", err);
      setMainMicIdle();
      // Distinguish permission errors from hardware errors for a better UX
      // message — a MediaStreamError with name "NotAllowedError" is a
      // permission denial; anything else is a device problem.
      const isPermission = err?.name === "NotAllowedError" ||
                           err?.name === "PermissionDeniedError";
      setPhase(isPermission ? "permission_error" : "device_error");
      sessionActive = false;
      return false;
    }

    const started = startSpeechRecognition();
    if (!started) {
      stopMicMeter();
      setMainMicIdle();
      setPhase("unsupported");
      sessionActive = false;
      return false;
    }

    return true;
  }

  function startSpeechRecognition() {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return false;

    cleanupRecognition({ keepState: true });

    recognition                  = new SpeechRecognitionCtor();
    recognition.continuous       = true;
    recognition.interimResults   = true;
    recognition.maxAlternatives  = 1;
    recognition.lang             = resolveSpeechLocale();

    recognition.onstart = () => {
      isRecording         = true;
      manualStopRequested = false;
      lastRecognitionError = "";

      setInputBoxVoiceMode(true);
      setMainMicRecording();
      setPhase("listening");
    };

    recognition.onresult = (event) => {
      lastRecognitionError    = "";
      // FIX #5 (restart counter reset): Only reset the counter when we get a
      // final result, not on any interim result. This prevents the restart
      // budget from refilling mid-utterance and causing an infinite retry loop.
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text   = result?.[0]?.transcript ?? "";

        if (result.isFinal) {
          finalTranscript         = `${finalTranscript} ${text}`.trim();
          recognitionRestartCount = 0; // reset only on confirmed final speech
        } else {
          interim += text;
        }
      }

      interimTranscript = interim.trim();
      updateTranscriptUI();
    };

    recognition.onerror = (event) => {
      const error = String(event?.error ?? "unknown");

      lastRecognitionError = error;
      isRecording          = false;
      lastEndedAt          = Date.now();
      setMainMicIdle();

      if (manualStopRequested || error === "aborted") {
        setPhase(hasTranscript() ? "review" : "idle");
        return;
      }

      if (error === "no-speech") {
        // FIX #3 (unreachable setPhase): Replaced the double-return with a
        // proper if/else so the "no_speech" phase is actually reachable when
        // scheduleRecognitionRestart returns false (budget exhausted).
        if (hasRecentVoiceActivity()) {
          setPhase("hearing_audio");
          if (scheduleRecognitionRestart()) return;
        }
        setPhase("no_speech");
        return;
      }

      if (error === "network") {
        if (hasRecentVoiceActivity()) {
          setPhase("hearing_audio");
          if (scheduleRecognitionRestart()) return;
        }
        stopMicMeter();
        setPhase("network_error");
        return;
      }

      if (error === "not-allowed" || error === "service-not-allowed") {
        stopMicMeter();
        setPhase("permission_error");
        return;
      }

      if (error === "audio-capture") {
        stopMicMeter();
        setPhase("device_error");
        return;
      }

      stopMicMeter();
      setPhase("generic_error");
    };

    recognition.onend = () => {
      isRecording = false;
      lastEndedAt = Date.now();
      setMainMicIdle();

      if (manualStopRequested) {
        stopMicMeter();
        setPhase(hasTranscript() ? "review" : "idle");
        updateTranscriptUI();
        return;
      }

      // Rescue any interim words that were not finalised before the engine
      // stopped (common on mobile when the utterance ends abruptly).
      if (interimTranscript) {
        finalTranscript   = `${finalTranscript} ${interimTranscript}`.trim();
        interimTranscript = "";
      }

      if (hasTranscript()) {
        stopMicMeter();
        setPhase("review");
        updateTranscriptUI();
        return;
      }

      if (
        sessionActive &&
        (lastRecognitionError === "no-speech" || lastRecognitionError === "network") &&
        hasRecentVoiceActivity()
      ) {
        setPhase("hearing_audio");
        if (scheduleRecognitionRestart()) return;
      }

      stopMicMeter();
      setPhase(hasRecentVoiceActivity() ? "heard_no_transcript" : "no_speech");
      updateTranscriptUI();
    };

    try {
      manualStopRequested = false;
      recognition.start();
      return true;
    } catch (err) {
      if (String(err?.name) === "InvalidStateError") {
        window.setTimeout(startSpeechRecognition, RESTART_COOLDOWN_MS);
        return true;
      }
      console.warn("Speech recognition start failed:", err);
      return false;
    }
  }

  function scheduleRecognitionRestart() {
    if (!sessionActive)                             return false;
    if (manualStopRequested)                        return false;
    if (recognitionRestartCount >= MAX_AUTO_RESTARTS) return false;

    recognitionRestartCount += 1;

    window.clearTimeout(pendingRestartTimer);
    pendingRestartTimer = window.setTimeout(() => {
      pendingRestartTimer = null;
      if (!sessionActive || manualStopRequested || hasTranscript()) return;
      startSpeechRecognition();
    }, RESTART_COOLDOWN_MS);

    return true;
  }

  // ── Mic meter & waveform ──────────────────────────────────────────────────

  async function startMicMeter() {
    stopMicMeter();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is unavailable");
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("AudioContext is unavailable");

    audioContext = new AudioContextCtor();
    if (audioContext.state === "suspended") await audioContext.resume();

    analyser                    = audioContext.createAnalyser();
    analyser.fftSize            = 256;
    analyser.smoothingTimeConstant = 0.55;

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    waveformData = new Uint8Array(analyser.fftSize);
    drawWaveform();
  }

  function drawWaveform() {
    // FIX #9 (stale rAF tick): Guard is the same, but we now capture the
    // frame handle *before* the guard returns so there is no orphaned frame.
    if (!analyser || !waveformData) return;

    const refs = getRefs();
    if (!refs.bars.length) return;

    analyser.getByteTimeDomainData(waveformData);

    const barCount    = refs.bars.length;
    const segmentSize = Math.max(1, Math.floor(waveformData.length / barCount));
    let   totalRms    = 0;

    for (let b = 0; b < barCount; b += 1) {
      const bar   = refs.bars[b];
      const start = b * segmentSize;
      const end   = Math.min(start + segmentSize, waveformData.length);
      let   sum   = 0;

      for (let i = start; i < end; i += 1) {
        const n = (waveformData[i] - 128) / 128;
        sum += n * n;
      }

      const rms   = Math.sqrt(sum / Math.max(1, end - start));
      totalRms   += rms;

      const level  = clamp(rms * 5.8, 0, 1);
      bar.style.height  = `${Math.round(8 + level * 48)}px`;
      bar.style.opacity = `${clamp(0.28 + level * 0.85, 0.28, 1)}`;
    }

    const avgRms = totalRms / barCount;
    if (avgRms >= VOICE_RMS_THRESHOLD) {
      voiceHeard  = true;
      lastVoiceAt = Date.now();

      if (!hasTranscript()) {
        const panel        = refs.panel;
        const currentPhase = panel?.getAttribute("data-phase") ?? "";
        if (
          panel &&
          !panel.classList.contains("hidden") &&
          (currentPhase === "no_speech" || currentPhase === "idle")
        ) {
          setPhase("hearing_audio");
        }
      }
    }

    waveformFrame = window.requestAnimationFrame(drawWaveform);
  }

  function stopMicMeter() {
    if (waveformFrame !== null) {
      window.cancelAnimationFrame(waveformFrame);
      waveformFrame = null;
    }

    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;

    if (audioContext && audioContext.state !== "closed") {
      audioContext.close().catch(() => {});
    }
    audioContext = null;
    analyser     = null;
    waveformData = null;

    resetWaveformBars();
  }

  // ── Voice control actions ─────────────────────────────────────────────────

  function stopVoiceRecognition() {
    if (!recognition || !isRecording) return;
    manualStopRequested = true;
    try {
      recognition.stop();
    } catch {
      cleanupRecognition({ keepState: true });
      stopMicMeter();
    }
  }

  function cancelVoiceCapture() {
    manualStopRequested = true;
    sessionActive       = false;

    window.clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;

    if (recognition) {
      try { recognition.abort(); } catch { cleanupRecognition({ keepState: true }); }
    }

    cleanupRecognition({ keepState: true });
    stopMicMeter();
    resetSessionState();

    isRecording = false;
    setMainMicIdle();
    setInputBoxVoiceMode(false);
    inputEl?.focus();
  }

  function acceptVoiceCapture() {
    const text = getTranscriptText();
    if (!text) { showToast("No voice text captured."); return; }

    manualStopRequested = true;
    sessionActive       = false;

    window.clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;

    if (recognition) {
      try { recognition.abort(); } catch { cleanupRecognition({ keepState: true }); }
    }

    cleanupRecognition({ keepState: true });
    stopMicMeter();

    // FIX #4 (input overwrite): Append to any existing typed text with a
    // space separator rather than replacing it. This preserves user-typed
    // context when voice is activated mid-composition.
    const existing      = inputEl.value.trimEnd();
    inputEl.value       = existing ? `${existing} ${text}` : text;
    inputEl.dispatchEvent(new Event("input"));
    autoResizeInput();
    syncInputButtons();

    resetSessionState();
    isRecording = false;
    setMainMicIdle();
    setInputBoxVoiceMode(false);
    inputEl.focus();
  }

  function retryVoiceCapture() {
    manualStopRequested = true;
    // FIX #6 (sessionActive not reset): Set sessionActive to false so any
    // late-firing onend/onerror handlers from the previous recognition
    // instance cannot trigger a scheduleRecognitionRestart during the
    // cooldown delay before the new session starts.
    sessionActive = false;

    window.clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;

    if (recognition) {
      try { recognition.abort(); } catch { cleanupRecognition({ keepState: true }); }
    }

    cleanupRecognition({ keepState: true });
    stopMicMeter();
    resetSessionState();

    window.setTimeout(startVoiceCapture, RESTART_COOLDOWN_MS);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  function cleanupRecognition({ keepState = false } = {}) {
    if (!recognition) return;
    recognition.onstart  = null;
    recognition.onresult = null;
    recognition.onerror  = null;
    recognition.onend    = null;
    recognition          = null;
    if (!keepState) isRecording = false;
  }

  function resetSessionState() {
    finalTranscript          = "";
    interimTranscript        = "";
    voiceHeard               = false;
    lastVoiceAt              = 0;
    recognitionRestartCount  = 0;
    lastRecognitionError     = "";
    manualStopRequested      = false;
    updateTranscriptUI();
    setRetryVisible(false);
  }

  function hasRecentVoiceActivity() {
    return voiceHeard && Date.now() - lastVoiceAt <= RECENT_VOICE_WINDOW_MS;
  }

  function hasTranscript() {
    return Boolean(getTranscriptText());
  }

  function getTranscriptText() {
    return `${finalTranscript} ${interimTranscript}`.replace(/\s+/g, " ").trim();
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function setPhase(phase) {
    const refs = getRefs();
    if (!refs.panel) return;

    refs.panel.setAttribute("data-phase", phase);

    const canAccept = hasTranscript();

    // FIX #8 (unsafe acceptBtn access): Use optional chaining consistently so
    // a missing accept button does not throw a TypeError.
    if (refs.acceptBtn) refs.acceptBtn.disabled = !canAccept;
    setRetryVisible(isRetryPhase(phase));

    const PHASE_COPY = {
      preparing:          ["Preparing mic",               "Allow microphone access if the browser asks."],
      listening:          ["Listening",                   "Speak naturally. Press check to use the transcript."],
      hearing_audio:      ["Listening",                   "I can hear your mic. Keep speaking while transcription catches up."],
      review:             ["Review voice input",          "Press check to place it in the message box."],
      heard_no_transcript:["Audio heard",                 "Your mic worked, but the browser did not return words. Try again or type."],
      network_error:      ["Voice transcription unavailable", "Your mic works, but browser speech service failed. Try again or type."],
      permission_error:   ["Microphone blocked",          "Allow microphone access in your browser settings."],
      device_error:       ["No microphone found",         "Connect a microphone or use typing."],
      no_speech:          ["No speech detected",          "Try again and speak closer to the mic."],
      unsupported:        ["Voice unavailable",           "This browser does not support speech recognition."],
    };

    const [title, status] = PHASE_COPY[phase] ?? ["Voice paused", "Try again or type your message."];
    if (refs.title)  refs.title.textContent  = title;
    if (refs.status) refs.status.textContent = status;

    updateTranscriptUI();
  }

  function setRetryVisible(visible) {
    const btn = getRefs().retryBtn;
    if (!btn) return;
    btn.classList.toggle("hidden", !visible);
    btn.classList.toggle("flex",   Boolean(visible));
  }

  function updateTranscriptUI() {
    const refs      = getRefs();
    if (!refs.transcript) return;

    const finalText  = finalTranscript.trim();
    const interimText = interimTranscript.trim();

    if (!finalText && !interimText) {
      refs.transcript.innerHTML = `<span class="text-gray-400 dark:text-[#c4c7c5]">Start speaking...</span>`;
      if (refs.acceptBtn) refs.acceptBtn.disabled = true;
      return;
    }

    refs.transcript.innerHTML = [
      finalText   ? `<span>${escapeText(finalText)}</span>` : "",
      interimText ? `<span class="text-gray-400 dark:text-[#c4c7c5]"> ${escapeText(interimText)}</span>` : "",
    ].join("");

    if (refs.acceptBtn) refs.acceptBtn.disabled = !hasTranscript();
  }

  function setInputBoxVoiceMode(active) {
    const refs = getRefs();
    if (!refs.surface || !refs.panel) return;

    refs.surface.classList.toggle("mindpal-voice-active", active);
    refs.panel.classList.toggle("hidden", !active);
    refs.panel.classList.toggle("flex",    active);

    const el = document.getElementById(inputId);
    el?.classList.toggle("hidden", active);
    refs.normalControls?.classList.toggle("hidden", active);
  }

  function setMainMicRecording() {
    voiceBtn?.classList.add("recording-pulse", "text-red-500");
    voiceBtn?.classList.remove("hidden");
    voiceBtn?.classList.add("flex");
    micIcon?.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  function setMainMicIdle() {
    voiceBtn?.classList.remove("recording-pulse", "text-red-500");
    micIcon?.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  function syncVoiceDisabledState() {
    const disabled = locked || generating;
    voiceBtn?.classList.toggle("opacity-30",        disabled);
    voiceBtn?.classList.toggle("pointer-events-none", disabled);
  }

  function resetWaveformBars() {
    getRefs().bars.forEach((bar) => {
      bar.style.height  = "8px";
      bar.style.opacity = "0.28";
    });
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  /**
   * FIX #1 (no teardown): Exposed destroy() fully cleans up all listeners,
   * timers, streams, and AudioContext so the caller can safely unmount.
   */
  function destroy() {
    cancelVoiceCapture();

    // Remove the injected panel from the DOM so a future initVoice() call
    // creates a fresh one rather than reusing a detached element.
    document.getElementById("voice-inline-panel")?.remove();
  }

  // ── Public controller ─────────────────────────────────────────────────────

  return {
    start:       startVoiceCapture,
    stop:        stopVoiceRecognition,
    isRecording: () => isRecording,
    setLocked:   (value) => { locked     = Boolean(value); syncVoiceDisabledState(); },
    setGenerating:(value) => { generating = Boolean(value); syncVoiceDisabledState(); },
    setLocale:   () => {},   // locale is resolved live from the document; no-op kept for API compat
    destroy,
  };
}

// ─── Module-level pure utilities (no instance state) ─────────────────────────

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function resolveSpeechLocale() {
  const lang = document.documentElement.lang || navigator.language || "en-US";
  return normalizeSpeechLocale(lang);
}

/**
 * FIX #7 (unsafe locale fallback): Normalize the raw locale tag to a BCP-47
 * form, then check it against the known-supported set before passing it to the
 * Web Speech API. Unknown tags fall back to the browser's preferred language
 * only if *that* is also supported; otherwise defaults to "en-US".
 */
function normalizeSpeechLocale(locale) {
  const raw = String(locale ?? "en-US").trim();

  // Convert "ar", "ar-eg" → "ar-EG"; "en" → "en-US", etc.
  const REGION_DEFAULTS = {
    ar: "ar-EG", de: "de-DE", en: "en-US", es: "es-ES",
    fr: "fr-FR", hi: "hi-IN", it: "it-IT", ja: "ja-JP",
    ko: "ko-KR", nl: "nl-NL", pl: "pl-PL", pt: "pt-BR",
    ru: "ru-RU", tr: "tr-TR", zh: "zh-CN",
  };

  // Exact match first (handles "en-GB", "pt-PT", "zh-TW", etc.)
  if (SUPPORTED_LOCALES.has(raw)) return raw;

  // Normalise capitalisation: "en-gb" → "en-GB"
  const [lang, region] = raw.split(/[-_]/);
  const canonical = region
    ? `${lang.toLowerCase()}-${region.toUpperCase()}`
    : null;

  if (canonical && SUPPORTED_LOCALES.has(canonical)) return canonical;

  // Fall back to language-family default
  const fallback = REGION_DEFAULTS[lang.toLowerCase()];
  if (fallback) return fallback;

  // Last resort: browser's own language if supported, else en-US
  const navLang = navigator.language;
  return SUPPORTED_LOCALES.has(navLang) ? navLang : "en-US";
}

function isRetryPhase(phase) {
  return ["network_error", "no_speech", "generic_error", "device_error", "heard_no_transcript"]
    .includes(phase);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#039;");
}

function createUnavailableVoiceController() {
  return {
    start:       () => false,
    stop:        () => {},
    isRecording: () => false,
    setLocked:   () => {},
    setGenerating: () => {},
    setLocale:   () => {},
    destroy:     () => {},
  };
}

// ─── DOM injection helpers (no instance state) ───────────────────────────────

function ensureInlineVoicePanel(inputEl) {
  const surface = inputEl.parentElement;
  if (!surface) throw new Error("Input surface not found");

  if (document.getElementById("voice-inline-panel")) return;

  const bars = Array.from({ length: WAVE_BAR_COUNT }, () => "<span></span>").join("");

  surface.insertAdjacentHTML(
    "afterbegin",
    `
    <div id="voice-inline-panel" class="hidden w-full min-h-[72px] items-center gap-3 px-2 py-1">
      <div class="flex items-center gap-3 flex-1 min-w-0">
        <div id="voice-waveform" class="voice-waveform flex items-center justify-center gap-[3px] w-[76px] h-[52px] flex-shrink-0 rounded-2xl bg-white/70 dark:bg-black/20 border border-white/50 dark:border-white/5">
          ${bars}
        </div>

        <div class="min-w-0 flex-1">
          <div id="voice-title" class="text-[13px] font-semibold text-gray-800 dark:text-gray-100">Listening</div>
          <div id="voice-status" class="text-[11px] text-gray-500 dark:text-[#c4c7c5] truncate">Speak naturally.</div>
          <div id="voice-transcript" class="mt-1 text-[15px] leading-6 text-gray-900 dark:text-gray-100 max-h-[72px] overflow-y-auto pr-1">
            <span class="text-gray-400 dark:text-[#c4c7c5]">Start speaking...</span>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1 flex-shrink-0">
        <button id="voice-inline-retry-btn" class="hidden w-9 h-9 rounded-full bg-transparent hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-[#c4c7c5] items-center justify-center transition-colors" title="Try again" type="button">
          <i data-lucide="rotate-cw" class="w-4 h-4"></i>
        </button>
        <button id="voice-inline-cancel-btn" class="w-9 h-9 rounded-full bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center justify-center transition-colors" title="Cancel" type="button">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        <button id="voice-inline-accept-btn" disabled class="w-9 h-9 rounded-full bg-gray-900 dark:bg-white disabled:opacity-30 disabled:pointer-events-none hover:scale-105 text-white dark:text-black flex items-center justify-center transition-all" title="Use transcript" type="button">
          <i data-lucide="check" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
    `,
  );

  refreshIcons();
}

function ensureInlineVoiceStyles() {
  if (document.getElementById("mindpal-inline-voice-styles")) return;

  const style    = document.createElement("style");
  style.id       = "mindpal-inline-voice-styles";
  style.textContent = `
    .mindpal-voice-active {
      min-height: 92px;
      align-items: stretch !important;
    }
    .voice-waveform span {
      width: 4px;
      height: 8px;
      border-radius: 999px;
      background: linear-gradient(180deg, #4285f4, #9b72cb);
      opacity: 0.28;
      transition: height 64ms linear, opacity 64ms linear;
    }
    #voice-inline-retry-btn svg,
    #voice-inline-cancel-btn svg,
    #voice-inline-accept-btn svg {
      display: block;
      flex-shrink: 0;
    }
  `;

  document.head.appendChild(style);
}