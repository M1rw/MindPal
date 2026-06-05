// frontend/js/voice.js

import {
  autoResizeInput,
  refreshIcons,
  showToast,
  syncInputButtons,
} from "./ui_state.js";

import {
  VOICE_LANGUAGE_OPTIONS,
  VOICE_LANGUAGE_FALLBACKS,
  SUPPORTED_VOICE_LOCALES,
  getVoiceLanguageLabel,
  getVoiceLocaleFallbackChain,
} from "./voice_languages.js";

/*
MindPal Voice State Machine

Design goals:
- Web Speech recognition never auto-retries after no-speech/network/device errors.
- Waveform is visual only; hardware waveform volume is the only audio detection signal.
- Retry is the only path from terminal error states back to recording.
- One cleanup path owns recognition, timers, mic stream, AudioContext, and UI.
- The panel design stays the same: inline waveform + transcript + retry/cancel/check.
*/

const RESTART_COOLDOWN_MS = 700;
const WAVE_BAR_COUNT = 12;
const VOICE_RMS_THRESHOLD = 0.030;

const VOICE_LANGUAGE_STORAGE_KEY = "mindpal_voice_language";
const VOICE_LANGUAGE_CONFIRM_STORAGE_KEY = "mindpal_voice_language_confirmed";

const PHASE = Object.freeze({
  IDLE: "idle",
  CONFIRMING_LANGUAGE: "confirming_language",
  PREPARING_MIC: "preparing_mic",
  LISTENING: "listening",
  STOPPING: "stopping",
  REVIEW: "review",
  NO_SPEECH: "no_speech",
  HEARD_NO_TRANSCRIPT: "heard_no_transcript",
  NETWORK_ERROR: "network_error",
  PERMISSION_ERROR: "permission_error",
  DEVICE_ERROR: "device_error",
  GENERIC_ERROR: "generic_error",
  UNSUPPORTED: "unsupported",
});

const TERMINAL_PHASES = new Set([
  PHASE.NO_SPEECH,
  PHASE.HEARD_NO_TRANSCRIPT,
  PHASE.NETWORK_ERROR,
  PHASE.PERMISSION_ERROR,
  PHASE.DEVICE_ERROR,
  PHASE.GENERIC_ERROR,
  PHASE.UNSUPPORTED,
]);

const RETRY_PHASES = new Set([
  PHASE.NO_SPEECH,
  PHASE.HEARD_NO_TRANSCRIPT,
  PHASE.NETWORK_ERROR,
  PHASE.DEVICE_ERROR,
  PHASE.GENERIC_ERROR,
  PHASE.UNSUPPORTED,
]);

const ACTIVE_PHASES = new Set([
  PHASE.CONFIRMING_LANGUAGE,
  PHASE.PREPARING_MIC,
  PHASE.LISTENING,
  PHASE.STOPPING,
]);

const PHASE_COPY = {
  [PHASE.IDLE]: ["Voice paused", "Try again or type your message."],
  [PHASE.CONFIRMING_LANGUAGE]: ["Confirm voice language", "Choose whether to continue recording."],
  [PHASE.PREPARING_MIC]: ["Preparing mic", "Allow microphone access if the browser asks."],
  [PHASE.LISTENING]: ["Listening", "Speak naturally. Press check to use the transcript."],
  [PHASE.STOPPING]: ["Stopping", "Finishing the current voice capture."],
  [PHASE.REVIEW]: ["Review voice input", "Press check to place it in the message box."],
  [PHASE.NO_SPEECH]: ["No speech detected", "Press retry and speak closer to the mic."],
  [PHASE.HEARD_NO_TRANSCRIPT]: ["Audio heard", "Your mic worked, but the browser did not return words. Press retry or type."],
  [PHASE.NETWORK_ERROR]: ["Voice transcription unavailable", "Browser speech service failed. Press retry or type."],
  [PHASE.PERMISSION_ERROR]: ["Microphone blocked", "Allow microphone access in your browser settings."],
  [PHASE.DEVICE_ERROR]: ["No microphone found", "Connect a microphone or use typing."],
  [PHASE.GENERIC_ERROR]: ["Voice error", "Press retry or type your message."],
  [PHASE.UNSUPPORTED]: ["Voice unavailable", "This browser does not support speech recognition."],
};

export function initVoice({
  inputId = "chat-input",
  voiceButtonId = "voice-btn",
  micIconId = "mic-icon",
} = {}) {
  const inputEl = document.getElementById(inputId);
  const voiceBtn = document.getElementById(voiceButtonId);
  const micIcon = document.getElementById(micIconId);

  if (!inputEl || !voiceBtn) {
    return createUnavailableVoiceController();
  }

  if (voiceBtn.__mindpalVoiceDestroy) {
    voiceBtn.__mindpalVoiceDestroy();
  }

  let phase = PHASE.IDLE;

  let recognition = null;
  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let waveformFrame = null;
  let waveformData = null;

  let isRecording = false;
  let sessionActive = false;
  let locked = false;
  let generating = false;
  let manualStopRequested = false;
  let startInFlight = false;

  let activeRunId = 0;
  let lastEndedAt = 0;
  let cooldownTimer = null;

  let finalTranscript = "";
  let interimTranscript = "";
  let audioDetected = false;

  let sessionLanguageConfirmationKey = "";
  const cleanupFns = [];

  ensureInlineVoiceStyles();
  ensureInlineVoicePanel(inputEl);
  ensureVoiceSettingsSelect();

  addDomListener(document.getElementById("voice-inline-cancel-btn"), "click", cancelVoiceCapture);
  addDomListener(document.getElementById("voice-inline-accept-btn"), "click", acceptVoiceCapture);
  addDomListener(document.getElementById("voice-inline-retry-btn"), "click", retryVoiceCapture);

  addDomListener(voiceBtn, "click", () => {
    if (locked || generating) return;

    if (ACTIVE_PHASES.has(phase)) {
      stopVoiceRecognition();
      return;
    }

    startVoiceCapture();
  });

  async function startVoiceCapture({ skipLanguageConfirmation = false } = {}) {
    if (locked || generating || startInFlight) return false;

    const waitMs = RESTART_COOLDOWN_MS - (Date.now() - lastEndedAt);

    if (waitMs > 0) {
      scheduleCooldownStart(waitMs, skipLanguageConfirmation);
      return true;
    }

    startInFlight = true;

    try {
      clearTimers();

      const SpeechRecognitionCtor = getSpeechRecognitionCtor();

      if (!SpeechRecognitionCtor) {
        openVoicePanel();
        enterPhase(PHASE.UNSUPPORTED);
        return false;
      }

      const selectedLanguage = loadVoiceLanguagePreference();
      const effectiveLocale = resolveEffectiveSpeechLocale(selectedLanguage);

      if (!skipLanguageConfirmation) {
        enterPhase(PHASE.CONFIRMING_LANGUAGE);

        const confirmed = await confirmLanguageOnce(selectedLanguage, effectiveLocale);

        if (!confirmed) {
          enterIdle({ closePanel: true });
          return false;
        }
      }

      resetCaptureState({ clearTranscript: true });
      openVoicePanel();

      sessionActive = true;
      manualStopRequested = false;
      activeRunId += 1;

      const runId = activeRunId;

      enterPhase(PHASE.PREPARING_MIC);

      if (shouldUseHardwareMicMeter()) {
        try {
          await startMicMeter();
        } catch (error) {
          console.warn("Mic capture failed:", error);

          const permissionError =
            error?.name === "NotAllowedError" ||
            error?.name === "PermissionDeniedError";

          endToTerminal(permissionError ? PHASE.PERMISSION_ERROR : PHASE.DEVICE_ERROR, { runId });
          return false;
        }
      } else {
        startSyntheticWaveform();
      }

      if (!startSpeechRecognition(effectiveLocale, runId, SpeechRecognitionCtor)) {
        endToTerminal(PHASE.GENERIC_ERROR, { runId });
        return false;
      }

      return true;
    } finally {
      startInFlight = false;
    }
  }

  function startSpeechRecognition(locale, runId, SpeechRecognitionCtor) {
    clearRecognition({ abort: true });

    recognition = new SpeechRecognitionCtor();
    recognition.continuous = !isMobileSpeechClient();
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = resolveSpeechRecognitionLocale(locale);

    recognition.onstart = () => {
      if (!isCurrentRun(runId)) return;

      isRecording = true;
      manualStopRequested = false;

      openVoicePanel();
      setMainMicRecording();
      enterPhase(PHASE.LISTENING);
    };

    recognition.onresult = (event) => {
      if (!isCurrentRun(runId)) return;

      let interim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";

        if (!text) continue;

        if (result.isFinal) {
          finalTranscript = `${finalTranscript} ${text}`.replace(/\s+/g, " ").trim();
        } else {
          interim += text;
        }
      }

      interimTranscript = interim.trim();
      updateTranscriptUI();
    };

    recognition.onerror = (event) => {
      if (!isCurrentRun(runId)) return;

      const error = String(event?.error ?? "unknown");
      isRecording = false;
      lastEndedAt = Date.now();
      setMainMicIdle();

      if (manualStopRequested || error === "aborted") {
        return;
      }

      if (error === "no-speech") {
        endToTerminal(PHASE.NO_SPEECH, { runId });
        return;
      }

      if (error === "network") {
        endToTerminal(PHASE.NETWORK_ERROR, { runId });
        return;
      }

      if (error === "not-allowed" || error === "service-not-allowed") {
        endToTerminal(PHASE.PERMISSION_ERROR, { runId });
        return;
      }

      if (error === "audio-capture") {
        endToTerminal(PHASE.DEVICE_ERROR, { runId });
        return;
      }

      endToTerminal(PHASE.GENERIC_ERROR, { runId });
    };

    recognition.onend = () => {
      if (!isCurrentRun(runId)) return;

      isRecording = false;
      lastEndedAt = Date.now();
      setMainMicIdle();

      if (interimTranscript) {
        finalTranscript = `${finalTranscript} ${interimTranscript}`.replace(/\s+/g, " ").trim();
        interimTranscript = "";
      }

      if (manualStopRequested) {
        if (hasTranscript()) {
          endToReview({ runId });
        } else {
          endToTerminal(PHASE.NO_SPEECH, { runId });
        }

        return;
      }

      if (hasTranscript()) {
        endToReview({ runId });
        return;
      }

      endToTerminal(audioDetected ? PHASE.HEARD_NO_TRANSCRIPT : PHASE.NO_SPEECH, { runId });
    };

    try {
      recognition.start();
      return true;
    } catch (error) {
      console.warn("Speech recognition start failed:", error);
      clearRecognition();
      return false;
    }
  }

  function startSyntheticWaveform() {
    stopMicMeter();

    const startedAt = Date.now();

    const draw = () => {
      const refs = getRefs();
      const bars = refs.bars;
      const elapsed = (Date.now() - startedAt) / 1000;

      for (let index = 0; index < bars.length; index += 1) {
        const wave = Math.sin(elapsed * 4.8 + index * 0.8);
        const level = 0.34 + Math.abs(wave) * 0.38;
        const bar = bars[index];

        if (bar) {
          bar.style.height = `${Math.round(10 + level * 28)}px`;
          bar.style.opacity = `${clamp(0.34 + level * 0.5, 0.34, 0.78)}`;
        }
      }

      waveformFrame = window.requestAnimationFrame(draw);
    };

    draw();
  }

  async function startMicMeter() {
    stopMicMeter();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is unavailable");
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;

    if (!AudioContextCtor) {
      throw new Error("AudioContext is unavailable");
    }

    audioContext = new AudioContextCtor();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.55;

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    waveformData = new Uint8Array(analyser.fftSize);
    drawWaveform();
  }

  function drawWaveform() {
    if (!analyser || !waveformData) return;

    analyser.getByteTimeDomainData(waveformData);

    const refs = getRefs();
    const bars = refs.bars;
    const barCount = Math.max(1, bars.length || WAVE_BAR_COUNT);
    const segmentSize = Math.max(1, Math.floor(waveformData.length / barCount));

    let totalRms = 0;

    for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
      const start = barIndex * segmentSize;
      const end = Math.min(start + segmentSize, waveformData.length);

      let sum = 0;

      for (let index = start; index < end; index += 1) {
        const normalized = (waveformData[index] - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / Math.max(1, end - start));
      const level = clamp(rms * 5.8, 0, 1);

      totalRms += rms;

      const bar = bars[barIndex];

      if (bar) {
        bar.style.height = `${Math.round(8 + level * 48)}px`;
        bar.style.opacity = `${clamp(0.28 + level * 0.85, 0.28, 1)}`;
      }
    }

    const averageRms = totalRms / barCount;

    if (averageRms >= VOICE_RMS_THRESHOLD) {
      audioDetected = true;
    }

    waveformFrame = window.requestAnimationFrame(drawWaveform);
  }

  function shouldUseHardwareMicMeter() {
    return !isMobileSpeechClient();
  }

  function isMobileSpeechClient() {
    const ua = navigator.userAgent || navigator.vendor || "";
    const touchPoints = navigator.maxTouchPoints || 0;
    const isIPadOS = navigator.platform === "MacIntel" && touchPoints > 1;

    return /iPad|iPhone|iPod|Android/i.test(ua) || isIPadOS;
  }

  function stopVoiceRecognition() {
    if (!ACTIVE_PHASES.has(phase)) return;

    manualStopRequested = true;
    enterPhase(PHASE.STOPPING);

    if (!recognition) {
      if (hasTranscript()) {
        endToReview();
      } else {
        cancelVoiceCapture();
      }

      return;
    }

    try {
      recognition.stop();
    } catch {
      if (hasTranscript()) {
        endToReview();
      } else {
        endToTerminal(PHASE.NO_SPEECH);
      }
    }
  }

  function cancelVoiceCapture() {
    activeRunId += 1;
    sessionActive = false;
    manualStopRequested = true;
    isRecording = false;

    clearTimers();
    clearRecognition({ abort: true });
    stopMicMeter();
    resetCaptureState({ clearTranscript: true });
    setMainMicIdle();
    enterIdle({ closePanel: true });

    inputEl.focus();
  }

  function acceptVoiceCapture() {
    const text = getTranscriptText();

    if (!text) {
      showToast("No voice text captured.");
      return;
    }

    activeRunId += 1;
    sessionActive = false;
    manualStopRequested = true;
    isRecording = false;

    clearTimers();
    clearRecognition({ abort: true });
    stopMicMeter();

    const existing = inputEl.value.trimEnd();
    inputEl.value = existing ? `${existing} ${text}` : text;
    inputEl.dispatchEvent(new Event("input"));

    autoResizeInput();
    syncInputButtons();

    resetCaptureState({ clearTranscript: true });
    setMainMicIdle();
    enterIdle({ closePanel: true });

    inputEl.focus();
  }

  function retryVoiceCapture() {
    if (locked || generating) return;

    activeRunId += 1;
    sessionActive = false;
    manualStopRequested = true;
    isRecording = false;

    clearTimers();
    clearRecognition({ abort: true });
    stopMicMeter();
    resetCaptureState({ clearTranscript: true });
    setMainMicIdle();
    openVoicePanel();

    window.setTimeout(() => {
      startVoiceCapture({ skipLanguageConfirmation: true });
    }, RESTART_COOLDOWN_MS);
  }

  function endToReview({ runId = activeRunId } = {}) {
    if (!isCurrentRun(runId)) return;

    sessionActive = false;
    manualStopRequested = false;
    isRecording = false;

    clearTimers();
    clearRecognition();
    stopMicMeter();
    setMainMicIdle();
    openVoicePanel();
    enterPhase(PHASE.REVIEW);
  }

  function endToTerminal(nextPhase, { runId = activeRunId } = {}) {
    if (!isCurrentRun(runId)) return;

    sessionActive = false;
    manualStopRequested = false;
    isRecording = false;

    clearTimers();
    clearRecognition();
    stopMicMeter();
    setMainMicIdle();
    openVoicePanel();
    enterPhase(nextPhase);
  }

  function enterIdle({ closePanel = false } = {}) {
    phase = PHASE.IDLE;

    if (closePanel) {
      setInputBoxVoiceMode(false);
    } else {
      enterPhase(PHASE.IDLE);
    }

    setMainMicIdle();
    setRetryVisible(false);
    updateTranscriptUI();
  }

  function enterPhase(nextPhase) {
    phase = nextPhase;

    const refs = getRefs();

    if (refs.panel) {
      refs.panel.setAttribute("data-phase", nextPhase);
    }

    const [title, status] = PHASE_COPY[nextPhase] ?? PHASE_COPY[PHASE.IDLE];

    if (refs.title) refs.title.textContent = title;
    if (refs.status) refs.status.textContent = status;

    if (refs.acceptBtn) {
      refs.acceptBtn.disabled = !hasTranscript();
    }

    setRetryVisible(RETRY_PHASES.has(nextPhase));
    updateTranscriptUI();
  }

  function openVoicePanel() {
    setInputBoxVoiceMode(true);
  }

  function resetCaptureState({ clearTranscript = true } = {}) {
    if (clearTranscript) {
      finalTranscript = "";
      interimTranscript = "";
    }

    audioDetected = false;
    manualStopRequested = false;
    updateTranscriptUI();
    setRetryVisible(false);
    resetWaveformBars();
  }

  function clearTimers() {
    if (cooldownTimer !== null) {
      window.clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function scheduleCooldownStart(waitMs, skipLanguageConfirmation) {
    if (cooldownTimer !== null) return;

    cooldownTimer = window.setTimeout(() => {
      cooldownTimer = null;
      startVoiceCapture({ skipLanguageConfirmation });
    }, Math.max(0, waitMs));
  }

  function clearRecognition({ abort = false } = {}) {
    if (!recognition) return;

    const current = recognition;
    recognition = null;

    current.onstart = null;
    current.onresult = null;
    current.onerror = null;
    current.onend = null;

    if (abort) {
      try {
        current.abort();
      } catch {
        // ignore native browser cleanup failures
      }
    }
  }

  function stopMicMeter() {
    if (waveformFrame !== null) {
      window.cancelAnimationFrame(waveformFrame);
      waveformFrame = null;
    }

    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;

    if (audioContext && audioContext.state !== "closed") {
      audioContext.close().catch(() => {});
    }

    audioContext = null;
    analyser = null;
    waveformData = null;

    resetWaveformBars();
  }

  function confirmLanguageOnce(selectedLanguage, effectiveLocale) {
    const confirmationKey = getConfirmationKey(selectedLanguage, effectiveLocale);

    if (sessionLanguageConfirmationKey === confirmationKey) {
      return Promise.resolve(true);
    }

    return confirmVoiceLanguageBeforeRecord(selectedLanguage, effectiveLocale).then((confirmed) => {
      if (confirmed) {
        sessionLanguageConfirmationKey = confirmationKey;
      }

      return confirmed;
    });
  }

  function resolveSpeechRecognitionLocale(locale) {
    const normalized = normalizeSpeechLocale(locale);
    const chain = getVoiceLocaleFallbackChain(normalized);

    return chain[0] || normalized || "en-US";
  }

  function hasTranscript() {
    return Boolean(getTranscriptText());
  }

  function getTranscriptText() {
    return `${finalTranscript} ${interimTranscript}`.replace(/\s+/g, " ").trim();
  }

  function isCurrentRun(runId) {
    return runId === activeRunId;
  }

  function updateTranscriptUI() {
    const refs = getRefs();

    if (!refs.transcript) return;

    const finalText = finalTranscript.trim();
    const interimText = interimTranscript.trim();

    if (!finalText && !interimText) {
      const placeholder = TERMINAL_PHASES.has(phase)
        ? "Press retry to record again, or type your message."
        : "Start speaking...";

      refs.transcript.innerHTML = `<span class="text-gray-400 dark:text-[#c4c7c5]">${escapeText(placeholder)}</span>`;

      if (refs.acceptBtn) {
        refs.acceptBtn.disabled = true;
      }

      return;
    }

    refs.transcript.innerHTML = [
      finalText ? `<span>${escapeText(finalText)}</span>` : "",
      interimText ? `<span class="text-gray-400 dark:text-[#c4c7c5]"> ${escapeText(interimText)}</span>` : "",
    ].join("");

    if (refs.acceptBtn) {
      refs.acceptBtn.disabled = !hasTranscript();
    }
  }

  function setInputBoxVoiceMode(active) {
    const refs = getRefs();

    if (!refs.surface || !refs.panel) return;

    refs.surface.classList.toggle("mindpal-voice-active", active);
    refs.panel.classList.toggle("hidden", !active);
    refs.panel.classList.toggle("flex", active);

    const input = document.getElementById(inputId);
    input?.classList.toggle("hidden", active);

    refs.normalControls?.classList.toggle("hidden", active);
  }

  function setMainMicRecording() {
    voiceBtn.classList.add("recording-pulse", "text-red-500");
    voiceBtn.classList.remove("hidden");
    voiceBtn.classList.add("flex");

    micIcon?.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  function setMainMicIdle() {
    voiceBtn.classList.remove("recording-pulse", "text-red-500");

    micIcon?.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  function syncVoiceDisabledState() {
    const disabled = locked || generating;

    voiceBtn.classList.toggle("opacity-30", disabled);
    voiceBtn.classList.toggle("pointer-events-none", disabled);
  }

  function resetWaveformBars() {
    getRefs().bars.forEach((bar) => {
      bar.style.height = "8px";
      bar.style.opacity = "0.28";
    });
  }

  function setRetryVisible(visible) {
    const btn = getRefs().retryBtn;

    if (!btn) return;

    btn.classList.toggle("hidden", !visible);
    btn.classList.toggle("flex", Boolean(visible));
  }

  function getRefs() {
    const input = document.getElementById(inputId);
    const surface = input?.parentElement ?? null;

    return {
      surface,
      panel: document.getElementById("voice-inline-panel"),
      title: document.getElementById("voice-title"),
      status: document.getElementById("voice-status"),
      transcript: document.getElementById("voice-transcript"),
      waveform: document.getElementById("voice-waveform"),
      bars: Array.from(document.querySelectorAll("#voice-waveform span")),
      cancelBtn: document.getElementById("voice-inline-cancel-btn"),
      acceptBtn: document.getElementById("voice-inline-accept-btn"),
      retryBtn: document.getElementById("voice-inline-retry-btn"),
      normalControls:
        document.getElementById("input-controls") ??
        document.getElementById("composer-controls") ??
        input?.nextElementSibling ??
        null,
    };
  }

  function addDomListener(target, eventName, handler, options) {
    if (!target) return;

    target.addEventListener(eventName, handler, options);
    cleanupFns.push(() => target.removeEventListener(eventName, handler, options));
  }

  function destroy() {
    activeRunId += 1;
    sessionActive = false;
    manualStopRequested = true;
    isRecording = false;

    clearTimers();
    clearRecognition({ abort: true });
    stopMicMeter();
    enterIdle({ closePanel: true });

    for (const cleanup of cleanupFns.splice(0)) {
      cleanup();
    }

    document.getElementById("voice-inline-panel")?.remove();

    if (voiceBtn.__mindpalVoiceDestroy === destroy) {
      voiceBtn.__mindpalVoiceDestroy = null;
    }
  }

  const controller = {
    start: startVoiceCapture,
    stop: stopVoiceRecognition,
    isRecording: () => isRecording,
    setLocked: (value) => {
      locked = Boolean(value);
      syncVoiceDisabledState();

      if (locked && ACTIVE_PHASES.has(phase)) {
        cancelVoiceCapture();
      }
    },
    setGenerating: (value) => {
      generating = Boolean(value);
      syncVoiceDisabledState();

      if (generating && ACTIVE_PHASES.has(phase)) {
        cancelVoiceCapture();
      }
    },
    setLocale: (value) => {
      saveVoiceLanguagePreference(value || "auto");
      clearVoiceLanguageConfirmation();
      sessionLanguageConfirmationKey = "";
    },
    destroy,
  };

  voiceBtn.__mindpalVoiceDestroy = destroy;

  return controller;
}

function ensureVoiceSettingsSelect() {
  const select =
    document.getElementById("voice-language-select") ??
    document.getElementById("voice-lang-select");

  if (!select) return;

  const current = loadVoiceLanguagePreference();

  select.innerHTML = VOICE_LANGUAGE_OPTIONS
    .map((option) => `<option value="${escapeAttribute(option.value)}">${escapeText(option.label)}</option>`)
    .join("");

  if (current.startsWith("custom:")) {
    select.insertAdjacentHTML(
      "beforeend",
      `<option value="${escapeAttribute(current)}">${escapeText(getVoiceLanguageLabel(current))}</option>`,
    );
  }

  select.value = current.startsWith("custom:") ? current : current || "auto";

  if (select.__mindpalVoiceLanguageBound) return;

  select.__mindpalVoiceLanguageBound = true;

  select.addEventListener("change", () => {
    let next = select.value;

    if (next === "custom") {
      const custom = window.prompt("Enter a BCP 47 speech language tag, e.g. fr-FR, ar-EG, en-US:");

      if (!custom) {
        select.value = loadVoiceLanguagePreference();
        return;
      }

      next = `custom:${normalizeCustomLocale(custom)}`;

      if (!Array.from(select.options).some((option) => option.value === next)) {
        select.insertAdjacentHTML(
          "beforeend",
          `<option value="${escapeAttribute(next)}">${escapeText(getVoiceLanguageLabel(next))}</option>`,
        );
      }
    }

    saveVoiceLanguagePreference(next);
    clearVoiceLanguageConfirmation();
    select.value = next;

    showToast(`Voice language set to ${getVoiceLanguageLabel(next)}.`);
  });
}

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

  const style = document.createElement("style");
  style.id = "mindpal-inline-voice-styles";
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

function confirmVoiceLanguageBeforeRecord(selectedLanguage, effectiveLocale) {
  const confirmationKey = getConfirmationKey(selectedLanguage, effectiveLocale);

  if (isVoiceLanguageConfirmed(confirmationKey)) {
    return Promise.resolve(true);
  }

  ensureVoiceLanguageConfirmDialog();

  const overlay = document.getElementById("voice-language-confirm-overlay");
  const title = document.getElementById("voice-language-confirm-title");
  const body = document.getElementById("voice-language-confirm-body");
  const cancelBtn = document.getElementById("voice-language-confirm-cancel");
  const continueBtn = document.getElementById("voice-language-confirm-continue");

  if (!overlay || !title || !body || !cancelBtn || !continueBtn) {
    markVoiceLanguageConfirmed(confirmationKey);
    return Promise.resolve(true);
  }

  const label =
    selectedLanguage === "auto"
      ? `Browser default (${getVoiceLanguageLabel(effectiveLocale)})`
      : getVoiceLanguageLabel(selectedLanguage);

  title.textContent = `Record in ${label}?`;
  body.textContent = `MindPal will use ${label} for voice transcription. You can change this anytime from Profile & Settings.`;
  continueBtn.textContent = "Continue";

  overlay.classList.remove("hidden");
  overlay.classList.add("flex");

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");

      cancelBtn.onclick = null;
      continueBtn.onclick = null;
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    continueBtn.onclick = () => {
      markVoiceLanguageConfirmed(confirmationKey);
      cleanup();
      resolve(true);
    };
  });
}

function ensureVoiceLanguageConfirmDialog() {
  if (document.getElementById("voice-language-confirm-overlay")) return;

  document.body.insertAdjacentHTML(
    "beforeend",
    `
      <div id="voice-language-confirm-overlay" class="fixed inset-0 z-[95] hidden items-center justify-center bg-black/25 dark:bg-black/60 backdrop-blur-sm px-4">
        <section class="w-full max-w-sm rounded-[28px] bg-white dark:bg-[#1e1f20] shadow-2xl border border-gray-100 dark:border-[#444746] p-5 animate-fade-in">
          <div class="w-12 h-12 rounded-full bg-gemini-surface dark:bg-zinc-800 flex items-center justify-center mb-4">
            <i data-lucide="languages" class="w-5 h-5 text-gray-700 dark:text-[#c4c7c5]"></i>
          </div>

          <h2 id="voice-language-confirm-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">Record?</h2>
          <p id="voice-language-confirm-body" class="mt-2 text-sm leading-6 text-gray-600 dark:text-[#c4c7c5]"></p>

          <div class="mt-6 flex items-center justify-end gap-2">
            <button id="voice-language-confirm-cancel" type="button" class="px-4 py-2 rounded-full text-sm font-medium hover:bg-gemini-surface dark:hover:bg-zinc-800 text-gray-600 dark:text-[#c4c7c5] transition-colors">
              Cancel
            </button>

            <button id="voice-language-confirm-continue" type="button" class="px-4 py-2 rounded-full text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black hover:scale-[1.02] transition-transform">
              Continue
            </button>
          </div>
        </section>
      </div>
    `,
  );

  refreshIcons();
}

function loadVoiceLanguagePreference() {
  try {
    return localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

function saveVoiceLanguagePreference(value) {
  try {
    localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, normalizeStoredVoiceLanguage(value));
  } catch {
    // ignore storage failures
  }
}

function clearVoiceLanguageConfirmation() {
  try {
    localStorage.removeItem(VOICE_LANGUAGE_CONFIRM_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function isVoiceLanguageConfirmed(key) {
  try {
    return localStorage.getItem(VOICE_LANGUAGE_CONFIRM_STORAGE_KEY) === key;
  } catch {
    return false;
  }
}

function markVoiceLanguageConfirmed(key) {
  try {
    localStorage.setItem(VOICE_LANGUAGE_CONFIRM_STORAGE_KEY, key);
  } catch {
    // ignore storage failures
  }
}

function getConfirmationKey(selectedLanguage, effectiveLocale) {
  return `${selectedLanguage || "auto"}:${effectiveLocale}`;
}

function normalizeStoredVoiceLanguage(value) {
  const raw = String(value || "auto").trim();

  if (!raw || raw === "auto") return "auto";

  if (raw.startsWith("custom:")) {
    return `custom:${normalizeCustomLocale(raw.slice("custom:".length))}`;
  }

  if (raw === "custom") return "custom";

  return normalizeSpeechLocale(raw);
}

function resolveEffectiveSpeechLocale(selectedLanguage) {
  const stored = normalizeStoredVoiceLanguage(selectedLanguage);

  if (stored === "auto") {
    return normalizeSpeechLocale(navigator.language || document.documentElement.lang || "en-US");
  }

  if (stored.startsWith("custom:")) {
    return normalizeCustomLocale(stored.slice("custom:".length));
  }

  return normalizeSpeechLocale(stored);
}

function normalizeSpeechLocale(locale) {
  const raw = String(locale || "en-US").trim();

  if (SUPPORTED_VOICE_LOCALES.has(raw)) return raw;

  const canonical = normalizeCustomLocale(raw);

  if (SUPPORTED_VOICE_LOCALES.has(canonical)) return canonical;

  const language = canonical.split("-")[0].toLowerCase();

  return VOICE_LANGUAGE_FALLBACKS[language] || "en-US";
}

function normalizeCustomLocale(locale) {
  const raw = String(locale || "en-US").trim().replaceAll("_", "-");

  if (!raw) return "en-US";

  const parts = raw.split("-").filter(Boolean);

  if (parts.length === 1) {
    return parts[0].toLowerCase();
  }

  return [
    parts[0].toLowerCase(),
    ...parts.slice(1).map((part) => (part.length === 2 ? part.toUpperCase() : titleCase(part))),
  ].join("-");
}

function titleCase(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll("`", "&#096;");
}

function createUnavailableVoiceController() {
  return {
    start: () => false,
    stop: () => {},
    isRecording: () => false,
    setLocked: () => {},
    setGenerating: () => {},
    setLocale: () => {},
    destroy: () => {},
  };
}
