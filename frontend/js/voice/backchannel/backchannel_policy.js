const DEFAULTS = Object.freeze({
  minimumSpeechMs: 8_000,
  minimumCooldownMs: 5_000,
  minimumConfidence: 0.55,
  minimumPauseMs: 180,
  maximumPauseMs: 1_200,
});

const SUPPRESSED_GATES = new Set(["crisis", "medical", "current-fact"]);

export function getBackchannelDecision(context = {}, now = Date.now(), options = {}) {
  const config = { ...DEFAULTS, ...options };
  const speechDurationMs = Math.max(0, Number(context.speechDurationMs) || 0);
  const pauseDurationMs = Math.max(0, Number(context.pauseDurationMs) || 0);
  const lastBackchannelAt = Math.max(0, Number(context.lastBackchannelAt) || 0);
  const transcriptConfidence = Number(context.transcriptConfidence);
  const hasConfidence = Number.isFinite(transcriptConfidence);

  if (!context.turnId) return { offer: false, reason: "no-active-turn" };
  if (context.userHasYielded) return { offer: false, reason: "user-yielded" };
  if (SUPPRESSED_GATES.has(context.safetyGate)) return { offer: false, reason: "safety-gate" };
  if (context.mainResponseStarted || context.isModelSpeaking) return { offer: false, reason: "main-response-active" };
  if (context.pendingBackchannel) return { offer: false, reason: "already-pending" };
  if (speechDurationMs < config.minimumSpeechMs) return { offer: false, reason: "story-too-short" };
  if (pauseDurationMs < config.minimumPauseMs) return { offer: false, reason: "pause-too-short" };
  if (pauseDurationMs > config.maximumPauseMs) return { offer: false, reason: "pause-too-long" };
  if (hasConfidence && transcriptConfidence < config.minimumConfidence) return { offer: false, reason: "low-transcript-confidence" };
  if (lastBackchannelAt > 0 && now - lastBackchannelAt < config.minimumCooldownMs) {
    return { offer: false, reason: "cooldown" };
  }

  const emotion = context.emotion || "neutral";
  const topic = context.topic || "story";
  const kind = emotion === "sad" || emotion === "overwhelmed"
    ? "empathy"
    : emotion === "frustrated" || topic === "anger"
      ? "validation"
      : topic === "decision"
        ? "attentive"
        : "encouragement";
  return { offer: true, reason: "eligible", kind };
}

export const BACKCHANNEL_DEFAULTS = DEFAULTS;
