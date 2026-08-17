// Deterministic policy for Voice turn ownership and factual freshness.
// Keep this module side-effect-free so its safety and lifecycle rules are tested
// independently of Web Audio and provider WebSocket events.

const VOLATILE_OFFICEHOLDER_RE = /\b(?:mayor|president|prime minister|governor|senator|representative|member of parliament|mp|ceo|chair(?:man|woman)?|minister|commissioner)\b/i;
const VOLATILE_FACT_RE = /\b(?:current|latest|today(?:'s)?|right now|now|price|cost|weather|score|standings?|election|officeholder)\b/i;
const VOLATILE_FACT_ARABIC_RE = /(?:عمدة|رئيس|رئيس الوزراء|محافظ|وزير|سعر|الطقس|نتيجة|الآن|حاليًا|اليوم)/;
const LOCAL_TIME_EN_RE = /\b(?:what(?:\s+is|'s)\s+(?:the\s+)?time|tell\s+me\s+(?:the\s+)?time|current\s+time|time\s+(?:right\s+)?now|what\s+time\s+is\s+it)\b/i;
const LOCAL_TIME_AR_RE = /(?:الساعة\s*(?:كام|كم|دلوقتي|الآن)?|الوقت\s*(?:دلوقتي|الآن)?|كم\s+الساعة)/;

function normalizeVoicePolicyText(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
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
