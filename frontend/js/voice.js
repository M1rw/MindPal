// frontend/js/voice.js

import {
  autoResizeInput,
  refreshIcons,
  showToast,
  syncInputButtons,
} from "./ui_state.js";

let recognition = null;
let isRecording = false;
let locked = false;
let generating = false;

export function initVoice({
  inputId = "chat-input",
  voiceButtonId = "voice-btn",
  micIconId = "mic-icon",
  onFinalTranscript = null,
  autoSend = true,
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
    voiceBtn.classList.add("recording-pulse");

    if (micIcon) {
      micIcon.setAttribute("data-lucide", "square");
      refreshIcons();
    }

    inputEl.placeholder = "Listening...";
    inputEl.value = "";
    autoResizeInput();
    syncInputButtons();
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

    const nextValue = finalTranscript || interimTranscript;

    if (nextValue) {
      inputEl.value = nextValue.trimStart();
      autoResizeInput();
      syncInputButtons();
    }
  };

  recognition.onerror = (event) => {
    const error = event?.error || "unknown";

    stopRecording({ inputEl, voiceBtn, micIcon });

    if (error === "not-allowed" || error === "service-not-allowed") {
      showToast("Microphone permission is blocked.");
      return;
    }

    if (error === "no-speech") {
      showToast("I didn’t catch anything. Try again.");
      return;
    }

    showToast("Microphone error. Try again.");
  };

  recognition.onend = () => {
    stopRecording({ inputEl, voiceBtn, micIcon });

    const text = inputEl.value.trim();

    if (
      autoSend &&
      text &&
      !locked &&
      !generating &&
      typeof onFinalTranscript === "function"
    ) {
      onFinalTranscript(text);
    }
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

  try {
    recognition.lang = resolveSpeechLocale();
    recognition.start();
    return true;
  } catch {
    showToast("Voice recognition is already running.");
    return false;
  }
}

export function stop() {
  if (!recognition || !isRecording) return;

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

function stopRecording({ inputEl, voiceBtn, micIcon }) {
  isRecording = false;

  voiceBtn?.classList.remove("recording-pulse");

  if (micIcon) {
    micIcon.setAttribute("data-lucide", "mic");
    refreshIcons();
  }

  if (inputEl && !locked) {
    inputEl.placeholder = "Ask MindPal";
  }

  syncInputButtons();
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