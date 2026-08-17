// Keep this module side-effect-free so its safety and lifecycle rules are tested
// independently of Web Audio and provider WebSocket events.

const VOLATILE_OFFICEHOLDER_RE = /\b(?:mayor|president|prime minister|governor|senator|representative|member of parliament|mp|ceo|chair(?:man|woman)?|minister|commissioner)\b/i;
const VOLATILE_FACT_RE = /\b(?:current|latest|today(?:'s)?|right now|now|price|cost|weather|score|standings?|election|officeholder)\b/i;
const VOLATILE_FACT_ARABIC_RE = /(?:عمدة|رئيس|رئيس الوزراء|محافظ|وزير|سعر|الطقس|نتيجة|الآن|حاليًا|اليوم)/;
const LOCAL_TIME_EN_RE = /\b(?:what(?:\s+is|'s)\s+(?:the\s+)?time|tell\s+me\s+(?:the\s+)?time|current\s+time|time\s+(?:right\s+)?now|what\s+time\s+is\s+it)\b/i;
const LOCAL_TIME_AR_RE = /(?:الساعة\s*(?:كام|كم|دلوقتي|الآن)?|الوقت\s*(?:دلوقتي|الآن)?|كم\s+الساعة)/;

const DEFAULT_NOISE_GATE_THRESHOLD = 0.008;
const DEFAULT_NOISE_FLOOR = 0.0025;

function normalizeVoicePolicyText(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
}

/**
 * Produces a capture-quality signal only. It never declares a semantic user turn:
 * Gemini automatic VAD remains the owner of yield and interruption boundaries.
 */
export function advanceVoiceNoiseGate({
  noiseFloorRms = DEFAULT_NOISE_FLOOR,
  speechFrameStreak = 0,
} = {}, rms, {
  minimumThreshold = DEFAULT_NOISE_GATE_THRESHOLD,
} = {}) {
  const measuredRms = Math.max(0, Number(rms) || 0);
  const priorFloor = Math.max(0.0001, Number(noiseFloorRms) || DEFAULT_NOISE_FLOOR);
  const floorEligible = measuredRms <= Math.max(0.022, priorFloor * 2.1);
  const nextNoiseFloorRms = floorEligible
    ? priorFloor * 0.965 + measuredRms * 0.035
    : priorFloor;
  const adaptiveThreshold = Math.min(
    0.020,
    Math.max(minimumThreshold, nextNoiseFloorRms * 1.7 + 0.002),
  );
  const candidateSpeech = measuredRms >= adaptiveThreshold;
  const nextSpeechFrameStreak = candidateSpeech
    ? Math.min(8, Math.max(0, Number(speechFrameStreak) || 0) + 1)
    : 0;
  const strongSpeech = measuredRms >= Math.max(adaptiveThreshold * 1.8, 0.014);

  return {
    next: {
      noiseFloorRms: nextNoiseFloorRms,
      speechFrameStreak: nextSpeechFrameStreak,
    },
    adaptiveThreshold,
    candidateSpeech,
    // A short keyboard transient may still be forwarded to provider VAD, but it
    // cannot change MindPal's visible turn state or trigger a barge-in fade.
    confirmedSpeech: candidateSpeech && nextSpeechFrameStreak >= (strongSpeech ? 2 : 5),
  };
}

/**
 * Maps local capture quality into non-semantic UI/telemetry state. The browser
 * must wait for the provider's interrupted event before clearing model playback.
 */
export function getVoiceCapturePolicy({ confirmedSpeech = false, isAiSpeaking = false } = {}) {
  if (!confirmedSpeech) {
    return { activity: "none", awaitProviderInterruption: false };
  }
  return isAiSpeaking
    ? { activity: "barge-in-pending", awaitProviderInterruption: true }
    : { activity: "user-speaking", awaitProviderInterruption: false };
}

/**
 * Provider automatic VAD is the sole authority for semantic boundaries. This
 * reducer gives runtime code one deterministic answer for playback and phase.
 */
export function reduceProviderTurnEvent({
  interrupted = false,
  turnComplete = false,
  captureSpeechActive = false,
  isMicMuted = false,
} = {}) {
  if (interrupted) {
    return {
      clearPlayback: true,
      clearCaptureActivity: false,
      nextPhase: isMicMuted ? "muted" : captureSpeechActive ? "attending" : "listening",
    };
  }
  if (turnComplete) {
    return {
      clearPlayback: false,
      clearCaptureActivity: true,
      nextPhase: isMicMuted ? "muted" : "listening",
    };
  }
  return { clearPlayback: false, clearCaptureActivity: false, nextPhase: null };
}

export function isVoiceLocalTimeRequest(value) {
  const text = normalizeVoicePolicyText(value);
  return Boolean(text && (LOCAL_TIME_EN_RE.test(text) || LOCAL_TIME_AR_RE.test(text)));
}

export function requiresVerifiedVoiceEvidence(value) {
  const text = normalizeVoicePolicyText(value);
  if (!text || isVoiceLocalTimeRequest(text)) return false;
  return Boolean(
    VOLATILE_OFFICEHOLDER_RE.test(text)
    || VOLATILE_FACT_RE.test(text)
    || VOLATILE_FACT_ARABIC_RE.test(text)
  );
}

export function isVoiceConversationBusy({
  isUserTurnActive = false,
  speechSeenRecently = false,
  isAiSpeaking = false,
  queuedAudioCount = 0,
  sessionPhase = "idle",
  toolCallPending = false,
  backgroundTaskCount = 0,
  awaitingModelResponseAt = 0,
  factVerificationPending = false,
} = {}) {
  return Boolean(
    isUserTurnActive
    || speechSeenRecently
    || isAiSpeaking
    || queuedAudioCount > 0
    || toolCallPending
    || backgroundTaskCount > 0
    || awaitingModelResponseAt
    || factVerificationPending
    || ["connecting", "preparing", "thinking", "speaking", "interrupting", "recovering", "holding", "attending"].includes(sessionPhase)
  );
}

export function getVoiceIdleAction({
  now = Date.now(),
  lastActivityTime = 0,
  isBusy = false,
  silenceAskedOnce = false,
  silenceWarnedOnce = false,
  askAfterMs,
  warnAfterMs,
  endAfterMs,
} = {}) {
  if (isBusy) return "none";
  const elapsed = Math.max(0, now - lastActivityTime);
  if (elapsed >= endAfterMs) return "end";
  if (elapsed >= warnAfterMs && !silenceWarnedOnce) return "warn";
  if (elapsed >= askAfterMs && !silenceAskedOnce) return "ask";
  return "none";
}
