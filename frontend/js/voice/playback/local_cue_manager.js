const DEFAULT_CUE_KEYS = Object.freeze({
  empathy: "empathy",
  validation: "validation",
  attentive: "attentive",
  encouragement: "encouragement",
  thinking: "thinking",
  checking: "checking",
  remembering: "remembering",
  calculating: "calculating",
  "checking-details": "checking-details",
  "careful-response": "careful-response",
});

const DEFAULT_TEXT = Object.freeze({
  empathy: "I hear you.",
  validation: "Yeah, that makes sense.",
  attentive: "Mm-hm.",
  encouragement: "Go on.",
  thinking: "Let me think about that for a moment.",
  checking: "Give me a second — I’m checking that properly.",
  remembering: "Let me look back at what I remember.",
  calculating: "Let me work that out carefully.",
  "checking-details": "Let me check the details.",
  "careful-response": "Let me think about that carefully.",
});

export function createLocalCueManager({
  audioUrls = {},
  allowSpeechSynthesis = false,
  AudioImpl = globalThis.Audio,
  speechSynthesisImpl = globalThis.speechSynthesis,
  SpeechSynthesisUtteranceImpl = globalThis.SpeechSynthesisUtterance,
  onEvent = () => {},
} = {}) {
  let activeAudio = null;
  let activeUtterance = null;
  let sequence = 0;

  function cancel(reason = "cancelled") {
    sequence += 1;
    if (activeAudio) {
      try { activeAudio.pause(); activeAudio.currentTime = 0; } catch { /* already ended */ }
      activeAudio = null;
    }
    if (activeUtterance && speechSynthesisImpl?.cancel) speechSynthesisImpl.cancel();
    activeUtterance = null;
    onEvent({ type: "local-cue.cancelled", reason });
  }

  function play(kind, { language = "en-US", volume = 0.72 } = {}) {
    const cueKey = DEFAULT_CUE_KEYS[kind] || kind;
    const url = audioUrls[cueKey];
    cancel("superseded");
    const currentSequence = ++sequence;
    if (url && typeof AudioImpl === "function") {
      const audio = new AudioImpl(url);
      audio.volume = volume;
      activeAudio = audio;
      audio.onended = () => { if (currentSequence === sequence) activeAudio = null; };
      void audio.play?.().then(() => onEvent({ type: "local-cue.started", kind, mode: "asset" })).catch((error) => {
        if (currentSequence === sequence) onEvent({ type: "local-cue.failed", kind, error });
      });
      return { ok: true, mode: "asset", kind };
    }
    if (allowSpeechSynthesis && speechSynthesisImpl?.speak && typeof SpeechSynthesisUtteranceImpl === "function") {
      const utterance = new SpeechSynthesisUtteranceImpl(DEFAULT_TEXT[kind] || DEFAULT_TEXT.attentive);
      utterance.lang = language || "en-US";
      utterance.volume = volume;
      utterance.rate = 0.92;
      activeUtterance = utterance;
      utterance.onend = () => { if (currentSequence === sequence) activeUtterance = null; };
      speechSynthesisImpl.speak(utterance);
      onEvent({ type: "local-cue.started", kind, mode: "speech-synthesis" });
      return { ok: true, mode: "speech-synthesis", kind };
    }
    onEvent({ type: "local-cue.skipped", kind, reason: "no-local-asset" });
    return { ok: false, skipped: true, reason: "no-local-asset", kind };
  }

  return Object.freeze({ play, cancel, isPlaying: () => Boolean(activeAudio || activeUtterance), getText: (kind) => DEFAULT_TEXT[kind] || DEFAULT_TEXT.attentive });
}

export { DEFAULT_CUE_KEYS, DEFAULT_TEXT };
