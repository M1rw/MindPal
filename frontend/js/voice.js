// frontend/js/voice.js

import {
  autoResizeInput,
  refreshIcons,
  showToast,
  syncInputButtons,
} from "./ui_state.js";

const RESTART_COOLDOWN_MS = 750;

let recognition = null;
let isRecording = false;
let locked = false;
let generating = false;
let manualStopRequested = false;
let pendingStartTimer = null;
let lastEndAt = 0;

export function initVoice({
  inputId = "chat-input",
  voiceButtonId = "voice-btn",
  micIconId = "mic-icon",
  onFinalTranscript = null,
  autoSend = false,
} = {}) {
  const inputEl = document.getElementById(inputId);
  const voiceBtn = document.getElementById(voiceButtonId);
  const micIcon = document.getElementById(micIconId);

  if (!voiceBtn || !inputEl) {
    return createUnavailableVoiceController();
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceBtn.style.display = "none";
    return createUnavailableVoiceController();
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = resolveSpeechLocale();

  recognition.onstart = () => {
    isRecording = true;
    manualStopRequested = false;

    voiceBtn.classList.add("recording-pulse");
    keepMicVisibleWhileRecording();

    if (micIcon) {
      micIcon.setAttribute("data-lucide", "square");
      refreshIcons();
    }

    inputEl.placeholder = "Listening...";
    inputEl.value = "";
    autoResizeInput();
  };

  recognition.onresult = (event) => {
    let finalTranscript = "";
    let interimTranscript = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";

      if (event.results[index].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    const nextValue = (finalTranscript || interimTranscript).trimStart();

    if (nextValue) {
      inputEl.value = nextValue;
      autoResizeInput();

      // Important: do NOT dispatch input while recording.
      // Dispatching input hides the mic and shows send while the user is still talking.
      keepMicVisibleWhileRecording();
    }
  };

  recognition.onerror = (event) => {
    const error = String(event?.error || "unknown");

    stopRecording({ inputEl, voiceBtn, micIcon, syncButtons: true });

    if (error === "aborted") {
      return;
    }

    if (error === "no-speech") {
      if (!manualStopRequested) {
        showToast("I didn’t catch anything. Try again.");
      }
      return;
    }

    if (error === "not-allowed" || error === "service-not-allowed") {
      showToast("Microphone permission is blocked.");
      return;
    }

    if (error === "audio-capture") {
      showToast("No microphone was found.");
      return;
    }

    if (error === "network") {
      showToast("Speech recognition network error.");
      return;
    }

    showToast("Microphone error. Try again.");
  };

  recognition.onend = () => {
    const wasManualStop = manualStopRequested;

    lastEndAt = Date.now();

    stopRecording({ inputEl, voiceBtn, micIcon, syncButtons: true });

    const text = inputEl.value.trim();

    // New behavior:
    // - do not auto-send after speaking
    // - leave transcript in the box
    // - show send button after recognition ends
    if (
      autoSend &&
      text &&
      !wasManualStop &&
      !locked &&
      !generating &&
      typeof onFinalTranscript === "function"
    ) {
      onFinalTranscript(text);
    }

    manualStopRequested = false;
  };

  voiceBtn.addEventListener("click", () => {
    if (locked || generating) return;

    if (isRecording) {
      stop();
      return;
    }

    start();
  });

  return {
    start,
    stop,
    isRecording: () => isRecording,
    setLocked: (value) => {
      locked = Boolean(value);
      syncVoiceDisabledState(voiceBtn);
    },
    setGenerating: (value) => {
      generating = Boolean(value);
      syncVoiceDisabledState(voiceBtn);
    },
    setLocale: (locale) => {
      if (recognition) {
        recognition.lang = normalizeSpeechLocale(locale);
      }
    },
  };
}

export function start() {
  if (!recognition || isRecording || locked || generating) return false;

  const now = Date.now();
  const remainingCooldown = RESTART_COOLDOWN_MS - (now - lastEndAt);

  if (remainingCooldown > 0) {
    window.clearTimeout(pendingStartTimer);

    pendingStartTimer = window.setTimeout(() => {
      pendingStartTimer = null;
      start();
    }, remainingCooldown);

    return true;
  }

  try {
    manualStopRequested = false;
    recognition.lang = resolveSpeechLocale();
    recognition.start();
    return true;
  } catch (error) {
    const name = String(error?.name || "");

    if (name === "InvalidStateError") {
      window.clearTimeout(pendingStartTimer);

      pendingStartTimer = window.setTimeout(() => {
        pendingStartTimer = null;
        start();
      }, RESTART_COOLDOWN_MS);

      return true;
    }

    showToast("Voice recognition could not start.");
    return false;
  }
}

export function stop() {
  if (!recognition || !isRecording) return;

  manualStopRequested = true;

  try {
    recognition.stop();
  } catch {
    isRecording = false;
  }
}

export function setVoiceLocked(value) {
  locked = Boolean(value);
}

export function setVoiceGenerating(value) {
  generating = Boolean(value);
}

function stopRecording({ inputEl, voiceBtn, micIcon, syncButtons }) {
  isRecording = false;

  voiceBtn?.classList.remove("recording-pulse");

  if (micIcon) {
    micIcon.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  if (inputEl && !locked) {
    inputEl.placeholder = "Ask MindPal";
  }

  if (syncButtons) {
    syncInputButtons();
  }
}

function keepMicVisibleWhileRecording() {
  const voiceBtn = document.getElementById("voice-btn");
  const sendBtn = document.getElementById("send-btn");

  if (voiceBtn) {
    voiceBtn.classList.remove("hidden");
    voiceBtn.classList.add("flex");
  }

  if (sendBtn) {
    sendBtn.classList.add("hidden");
    sendBtn.classList.remove("flex");
    sendBtn.disabled = true;
  }
}

function syncVoiceDisabledState(voiceBtn) {
  const disabled = locked || generating;

  voiceBtn?.classList.toggle("opacity-30", disabled);
  voiceBtn?.classList.toggle("pointer-events-none", disabled);
}

function createUnavailableVoiceController() {
  return {
    start: () => false,
    stop: () => {},
    isRecording: () => false,
    setLocked: () => {},
    setGenerating: () => {},
    setLocale: () => {},
  };
}

function resolveSpeechLocale() {
  const lang = document.documentElement.lang || navigator.language || "en-US";
  return normalizeSpeechLocale(lang);
}

function normalizeSpeechLocale(locale) {
  const raw = String(locale || "en-US").trim().toLowerCase();

  if (raw.startsWith("ar")) return "ar-EG";
  if (raw.startsWith("en")) return "en-US";

  return navigator.language || "en-US";
}
