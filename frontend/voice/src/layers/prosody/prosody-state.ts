export type ProsodyState = {
  readonly energyLevel: "low" | "normal" | "high" | "very_high";
  readonly speechRate: "slow" | "normal" | "fast" | "very_fast";
  readonly pausePattern: "continuous" | "natural" | "hesitant" | "abrupt";
  readonly emotionalGuess: "neutral" | "calm" | "excited" | "frustrated" | "angry" | "sad" | "urgent";
  readonly confidence: number;
  readonly lastChangedAtMono: number;
};

export type BackchannelStyle = "standard" | "responsive" | "calm" | "soft" | "concise" | "patient";

export type ProsodyContextReason = "turn-finalized" | "high-confidence-state-change";

export type ProsodySnapshot = {
  readonly state: ProsodyState;
  readonly noiseFloorRms: number;
  readonly lastContextNote: string | null;
  readonly lastContextReason: ProsodyContextReason | null;
  readonly backchannelStyle: BackchannelStyle;
  readonly speechWindowMs: number;
  readonly transcriptRateWpm: number;
  readonly interruptionCount: number;
};

export const DEFAULT_PROSODY_STATE: ProsodyState = {
  energyLevel: "normal",
  speechRate: "normal",
  pausePattern: "continuous",
  emotionalGuess: "neutral",
  confidence: 0,
  lastChangedAtMono: 0,
};

export function backchannelStyleForProsody(state: ProsodyState): BackchannelStyle {
  switch (state.emotionalGuess) {
    case "excited": return "responsive";
    case "frustrated":
    case "angry": return "calm";
    case "sad": return "soft";
    case "urgent": return "concise";
    default:
      return state.pausePattern === "hesitant" ? "patient" : "standard";
  }
}

export function contextNoteForProsody(state: ProsodyState): string | null {
  if (state.confidence < 0.65) return null;
  switch (state.emotionalGuess) {
    case "neutral": return "User's tone appears neutral. Respond naturally.";
    case "calm": return "User sounds calm. Respond warmly at a steady pace.";
    case "urgent": return "User sounds urgent. Respond concisely and calmly.";
    case "frustrated": return "User sounds frustrated. Acknowledge briefly, do not be overly cheerful.";
    case "angry": return "User sounds angry. Stay calm, concise, and non-confrontational.";
    case "sad": return "User sounds sad. Use a gentle, supportive pace.";
    case "excited": return "User sounds excited. Match the energy while staying clear and grounded.";
    default:
      return state.pausePattern === "hesitant" ? "User sounds hesitant. Use a gentle pace." : null;
  }
}
