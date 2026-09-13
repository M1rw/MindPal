// frontend/js/utils/tts.js — Text-to-speech, clipboard, and safety helpers

import { refreshIcons } from "./icons.js";

let activeSpeechUtterance = null;
let activeSpeechButton = null;
const cancelledUtterances = new WeakSet();

// ═══════════════════════════════════════════════════════════════
// Text-to-Speech
// ═══════════════════════════════════════════════════════════════

export function speakText(text, button = null, { showToast } = {}) {
  if (!("speechSynthesis" in window)) {
    showToast?.("Text-to-speech is not supported in this browser.");
    return;
  }

  const clean = String(text || "").trim();
  if (!clean) return;

  const sameButton = activeSpeechButton === button;

  if (window.speechSynthesis.speaking || activeSpeechUtterance) {
    if (activeSpeechUtterance) {
      cancelledUtterances.add(activeSpeechUtterance);
    }

    window.speechSynthesis.cancel();
    resetPlayButton(activeSpeechButton);

    activeSpeechUtterance = null;
    activeSpeechButton = null;

    if (sameButton) {
      return;
    }
  }

  const utterance = new SpeechSynthesisUtterance(clean);

  // Smart language detection
  if (/[\u0600-\u06FF]/.test(clean)) {
    utterance.lang = "ar-SA";
  } else if (/[\u4E00-\u9FFF]/.test(clean)) {
    utterance.lang = "zh-CN";
  } else if (/[áéíóúñ¿¡]/i.test(clean)) {
    utterance.lang = "es-ES";
  } else if (/[\u0400-\u04FF]/.test(clean)) {
    utterance.lang = "ru-RU";
  } else if (/[\u3040-\u30FF]/.test(clean)) {
    utterance.lang = "ja-JP";
  } else if (/[\uAC00-\uD7AF]/.test(clean)) {
    utterance.lang = "ko-KR";
  } else if (/[\u0900-\u097F]/.test(clean)) {
    utterance.lang = "hi-IN";
  } else if (/[çãõáéíóú]/i.test(clean) && !/[ñ¿¡]/.test(clean)) {
    utterance.lang = "pt-BR";
  } else {
    utterance.lang = "en-US";
  }

  utterance.rate = 0.95;
  utterance.pitch = 1;

  activeSpeechUtterance = utterance;
  activeSpeechButton = button;

  setPlayButtonActive(button);

  utterance.onend = () => {
    if (cancelledUtterances.has(utterance)) {
      cancelledUtterances.delete(utterance);
      return;
    }

    activeSpeechUtterance = null;
    activeSpeechButton = null;
    resetPlayButton(button);
  };

  utterance.onerror = () => {
    if (cancelledUtterances.has(utterance)) {
      cancelledUtterances.delete(utterance);
      return;
    }

    activeSpeechUtterance = null;
    activeSpeechButton = null;
    resetPlayButton(button);
    showToast?.("Could not read this response aloud.");
  };

  window.setTimeout(() => {
    if (activeSpeechUtterance === utterance) {
      window.speechSynthesis.speak(utterance);
    }
  }, 80);
}

function setPlayButtonActive(button) {
  if (!button) return;
  const icon = button.querySelector("[data-lucide]");
  icon?.setAttribute("data-lucide", "square");
  button.classList.add("text-blue-600", "dark:text-blue-400");
  refreshIcons();
}

function resetPlayButton(button) {
  if (!button) return;
  const icon = button.querySelector("[data-lucide]");
  icon?.setAttribute("data-lucide", "volume-2");
  button.classList.remove("text-blue-600", "dark:text-blue-400");
  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════
// Clipboard
// ═══════════════════════════════════════════════════════════════

export function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

// ═══════════════════════════════════════════════════════════════
// Safety detection
// ═══════════════════════════════════════════════════════════════

export function isSafetyLock(response) {
  const level = String(response?.safety?.level || "").toLowerCase();
  const category = String(response?.safety?.user_visible_category || "").toLowerCase();

  return Boolean(
    response?.lock_session ||
    level.includes("imminent") ||
    level.includes("self_harm") ||
    category.includes("crisis") ||
    category.includes("emergency"),
  );
}

export function isCrisisReply(text, safetyLevel) {
  const haystack = `${text || ""} ${safetyLevel || ""}`.toLowerCase();

  return (
    haystack.includes("emergency") ||
    haystack.includes("988") ||
    haystack.includes("nearest emergency") ||
    haystack.includes("self_harm_imminent") ||
    haystack.includes("اتصل") ||
    haystack.includes("الإسعاف")
  );
}

// ═══════════════════════════════════════════════════════════════
// Locale
// ═══════════════════════════════════════════════════════════════

export function resolveLocale(getAppSettings) {
  const configured = getAppSettings().language;
  if (configured === "ar-EG") return "ar";
  if (configured === "en") return "en";
  return "auto";
}
