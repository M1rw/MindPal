import type { GenerationIdentity, LayerLinkEnvelope } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";

export const AFFECT_CONTEXT_COOLDOWN_MS = 900;
export const AFFECT_MIN_TRANSCRIPT_CHARS = 2;
export const AFFECT_DEFAULT_TAU_MS = 20_000;
export const AFFECT_TRUST_TAU_MS = 45_000;

export type AffectStance =
  | "warm-supportive"
  | "bright-playful"
  | "confident-banter"
  | "calm-firm"
  | "gentle-concern"
  | "curious-clarifying"
  | "steady-neutral";

export type AffectSignals = {
  readonly energy: number;
  readonly pace: number;
  readonly humor: number;
  readonly respect: number;
  readonly hostility: number;
  readonly challenge: number;
  readonly distress: number;
  readonly goalClarity: number;
  readonly cooperation: number;
  readonly ambiguity: number;
};

export type DerivedFeelings = {
  /** These are computed behavior controls, not claims of consciousness. */
  readonly joy: number;
  readonly calm: number;
  readonly empathy: number;
  readonly confidence: number;
  readonly curiosity: number;
  readonly concern: number;
  readonly frustration: number;
  readonly playfulness: number;
};

export type AffectState = {
  readonly version: number;
  readonly warmth: number;
  readonly activation: number;
  readonly playfulness: number;
  readonly assertiveness: number;
  readonly trust: number;
  readonly boundaryPressure: number;
  readonly uncertainty: number;
  readonly valence: number;
  readonly stance: AffectStance;
  readonly dominantFeeling: keyof DerivedFeelings;
  readonly feelings: DerivedFeelings;
  readonly lastSignals: AffectSignals;
  readonly lastTextAtMono: number;
  readonly lastChangedAtMono: number;
};

export type AffectContextPayload = {
  readonly version: number;
  readonly prompt: string;
  readonly stance: AffectStance;
  readonly state: AffectState;
};

export type AffectEngineOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly nowMono?: () => number;
  readonly sessionGeneration?: string;
  readonly contextCooldownMs?: number;
};

const EMPTY_IDENTITY: GenerationIdentity = {
  sessionGeneration: "affect-unassigned",
  turnId: null,
  providerResponseId: null,
  playbackGeneration: null,
};

const DEFAULT_SIGNALS: AffectSignals = {
  energy: 0.35,
  pace: 0.35,
  humor: 0,
  respect: 0.35,
  hostility: 0,
  challenge: 0,
  distress: 0,
  goalClarity: 0.35,
  cooperation: 0.45,
  ambiguity: 0.45,
};

const DEFAULT_FEELINGS: DerivedFeelings = {
  joy: 0.35,
  calm: 0.65,
  empathy: 0.55,
  confidence: 0.55,
  curiosity: 0.45,
  concern: 0.1,
  frustration: 0,
  playfulness: 0.1,
};

const DEFAULT_STATE: AffectState = {
  version: 0,
  warmth: 0.62,
  activation: 0.35,
  playfulness: 0.18,
  assertiveness: 0.3,
  trust: 0.55,
  boundaryPressure: 0,
  uncertainty: 0.4,
  valence: 0.28,
  stance: "steady-neutral",
  dominantFeeling: "calm",
  feelings: DEFAULT_FEELINGS,
  lastSignals: DEFAULT_SIGNALS,
  lastTextAtMono: 0,
  lastChangedAtMono: 0,
};

const WORDS = {
  humor: /\b(?:haha+|hehe+|lol|lmao|rofl|joke|joking|kidding|funny|😂|🤣)\b/iu,
  respect: /\b(?:please|thanks|thank you|appreciate|good point|you(?:'re| are) right|fair enough|respect)\b/iu,
  hostility: /\b(?:idiot|stupid|worthless|shut up|hate you|moron|loser|pathetic|dumb)\b/iu,
  challenge: /\b(?:bet you can(?:'t| not)|prove it|impress me|watch me|you think you(?:'re| are)|try me|challenge|genius|alpha|boss|smarter than)\b/iu,
  distress: /\b(?:sad|depressed|overwhelmed|anxious|panic|panicking|hopeless|alone|crying|tired|exhausted|hurt|scared|afraid)\b/iu,
  cooperation: /\b(?:help me|can you|could you|i want to|i need to|let(?:'s| us)|please|what should|how do i)\b/iu,
  goal: /\b(?:goal|plan|decide|build|finish|solve|learn|understand|figure out|achieve|practice|prepare)\b/iu,
};

/**
 * A deterministic, local affect controller. It turns short-lived interaction
 * signals into slowly changing behavioral state. It never stores audio bytes,
 * raw transcripts, or hidden reasoning; only bounded scalar signals are kept.
 */
export class AffectEngine {
  private readonly bus: LayerLinkMessageBus;
  private readonly nowMono: () => number;
  private readonly sessionGeneration: string;
  private readonly contextCooldownMs: number;
  private readonly unsubscribers: Array<() => void> = [];
  private stateValue: AffectState = DEFAULT_STATE;
  private lastContextSentAt = 0;
  private lastContextKey = "";
  private pendingContext: AffectContextPayload | null = null;
  private contextTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCaptureRms = 0;
  private lastCaptureAtMono = 0;

  public constructor(options: AffectEngineOptions) {
    this.bus = options.bus;
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.sessionGeneration = options.sessionGeneration ?? "affect-session";
    this.contextCooldownMs = Math.max(200, options.contextCooldownMs ?? AFFECT_CONTEXT_COOLDOWN_MS);
    this.lastContextSentAt = this.nowMono();
    this.unsubscribers.push(
      this.bus.subscribe<unknown>((envelope) => this.handleProviderEnvelope(envelope), {
        topic: "voice.provider",
        messageType: "adapter.event",
      }),
      this.bus.subscribe<unknown>((envelope) => this.handleCaptureEnvelope(envelope), {
        topic: "voice.capture",
        messageType: "capture.frame",
      }),
    );
    this.emitState();
  }

  public get state(): AffectState {
    return this.stateValue;
  }

  public dispose(): void {
    if (this.contextTimer !== null) clearTimeout(this.contextTimer);
    this.contextTimer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  public reset(): void {
    this.stateValue = {
      ...DEFAULT_STATE,
      version: this.stateValue.version + 1,
      lastChangedAtMono: this.nowMono(),
      lastSignals: DEFAULT_SIGNALS,
    };
    this.lastContextKey = "";
    this.emitState();
    this.queueContextUpdate(true);
  }

  private handleProviderEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const event = parseVoiceEvent(envelope.payload);
    if (!event) return;
    if (event.type === "PROVIDER_INPUT_TRANSCRIPT") {
      this.ingestUserText(event.payload.text, event.payload.isFinal === true);
    } else if (event.type === "PROVIDER_INTERRUPTED") {
      this.applySignals({
        ...this.stateValue.lastSignals,
        energy: Math.max(this.stateValue.lastSignals.energy, 0.7),
        hostility: Math.max(this.stateValue.lastSignals.hostility, 0.12),
        challenge: Math.max(this.stateValue.lastSignals.challenge, 0.15),
      }, this.nowMono(), "interruption");
    }
  }

  private handleCaptureEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const value = envelope.payload as { readonly rms?: unknown; readonly muted?: unknown };
    if (typeof value.rms !== "number" || !Number.isFinite(value.rms)) return;
    const now = this.nowMono();
    this.lastCaptureRms = Math.max(0, value.rms);
    this.lastCaptureAtMono = now;
    // Capture energy is deliberately a weak signal. It can shape activation,
    // but it cannot independently label the user angry, sad, or disrespectful.
    if (value.muted === true) return;
    const energy = clamp(this.lastCaptureRms / 0.18, 0, 1);
    if (Math.abs(energy - this.stateValue.lastSignals.energy) < 0.08) return;
    this.applySignals({ ...this.stateValue.lastSignals, energy }, now, "capture-energy");
  }

  private ingestUserText(text: string, isFinal: boolean): void {
    const normalized = text.trim();
    if (normalized.length < AFFECT_MIN_TRANSCRIPT_CHARS) return;
    const now = this.nowMono();
    const signals = extractSignals(normalized, this.stateValue.lastSignals, isFinal);
    this.applySignals(signals, now, "user-text");
  }

  private applySignals(signals: AffectSignals, now: number, reason: string): void {
    const previous = this.stateValue;
    const dtMs = previous.lastChangedAtMono > 0 ? Math.max(0, now - previous.lastChangedAtMono) : AFFECT_DEFAULT_TAU_MS;
    const tau = reason === "user-text"
      ? 8_000
      : this.stateValue.lastSignals.hostility > 0.3 ? 12_000 : AFFECT_DEFAULT_TAU_MS;
    const alpha = 1 - Math.exp(-Math.min(dtMs, 60_000) / tau);
    const trustAlpha = 1 - Math.exp(-Math.min(dtMs, 60_000) / AFFECT_TRUST_TAU_MS);
    const decaySeconds = previous.lastChangedAtMono === 0 ? 0 : Math.min(dtMs / 1_000, 4);
    const boundaryPressure = clamp(
      previous.boundaryPressure + 0.18 * signals.hostility + 0.10 * signals.challenge - 0.06 * signals.respect - 0.025 * decaySeconds,
      0,
      1,
    );
    const trust = clamp(
      previous.trust + trustAlpha * (0.035 * (signals.respect - 0.8 * boundaryPressure + signals.cooperation - 0.5 * signals.ambiguity)),
      0,
      1,
    );
    const effectivePlayfulness = clamp(signals.humor * trust * (1 - boundaryPressure) * signals.goalClarity, 0, 1);
    const warmthTarget = clamp(0.5 + 0.36 * signals.respect + 0.22 * signals.distress - 0.3 * boundaryPressure, 0, 1);
    const activationTarget = clamp(0.18 + 0.62 * signals.energy + 0.2 * signals.pace, 0, 1);
    const assertivenessTarget = clamp(0.25 + 0.55 * boundaryPressure + 0.2 * signals.challenge + 0.12 * (1 - trust), 0.25, 1);
    const valenceTarget = clamp(
      0.55 * signals.humor + 0.22 * signals.respect + 0.16 * signals.cooperation - 0.7 * signals.distress - 0.8 * boundaryPressure,
      -1,
      1,
    );
    const next: AffectState = {
      ...previous,
      version: previous.version + 1,
      warmth: smooth(previous.warmth, warmthTarget, alpha),
      activation: smooth(previous.activation, activationTarget, alpha),
      playfulness: smooth(previous.playfulness, effectivePlayfulness, alpha),
      assertiveness: smooth(previous.assertiveness, assertivenessTarget, alpha),
      trust,
      boundaryPressure,
      uncertainty: smooth(previous.uncertainty, signals.ambiguity, alpha),
      valence: smooth(previous.valence, valenceTarget, alpha),
      lastSignals: signals,
      lastTextAtMono: now,
      lastChangedAtMono: now,
      stance: "steady-neutral",
      dominantFeeling: "calm",
      feelings: DEFAULT_FEELINGS,
    };
    const withFeelings = deriveFeelings(next);
    const finalState = {
      ...withFeelings,
      stance: chooseStance(withFeelings),
      dominantFeeling: dominantFeeling(withFeelings.feelings),
    } satisfies AffectState;
    if (!meaningfullyChanged(previous, finalState)) return;
    this.stateValue = finalState;
    this.emitState();
    this.queueContextUpdate(false);
  }

  private emitState(): void {
    this.bus.publish(createEventEnvelope({
      messageId: `affect-state-${this.sessionGeneration}-${this.stateValue.version}`,
      messageType: "affect.state.updated",
      sourceLayer: "affect",
      topic: "voice.affect",
      priority: "telemetry",
      timestampMono: this.nowMono(),
      ttlMs: 10_000,
      identity: { ...EMPTY_IDENTITY, sessionGeneration: this.sessionGeneration },
      correlationId: "affect-engine",
      payload: this.stateValue,
    }));
  }

  private queueContextUpdate(immediate: boolean): void {
    const payload: AffectContextPayload = {
      version: this.stateValue.version,
      prompt: buildAffectPrompt(this.stateValue),
      stance: this.stateValue.stance,
      state: this.stateValue,
    };
    const key = `${payload.stance}|${Math.round(payload.state.activation * 10)}|${Math.round(payload.state.warmth * 10)}|${Math.round(payload.state.playfulness * 10)}|${Math.round(payload.state.assertiveness * 10)}|${Math.round(payload.state.uncertainty * 10)}`;
    if (key === this.lastContextKey && !immediate) return;
    this.lastContextKey = key;
    this.pendingContext = payload;
    const now = this.nowMono();
    const delay = immediate ? 0 : Math.max(0, this.contextCooldownMs - (now - this.lastContextSentAt));
    if (this.contextTimer !== null) clearTimeout(this.contextTimer);
    if (delay === 0) {
      this.emitPendingContext();
      return;
    }
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      this.emitPendingContext();
    }, delay);
  }

  private emitPendingContext(): void {
    const next = this.pendingContext;
    if (!next) return;
    this.pendingContext = null;
    this.lastContextSentAt = this.nowMono();
    this.bus.publish(createEventEnvelope({
      messageId: `affect-context-${this.sessionGeneration}-${next.version}`,
      messageType: "affect.context.updated",
      sourceLayer: "affect",
      targetLayer: "transport",
      topic: "voice.transport",
      priority: "high",
      timestampMono: this.nowMono(),
      ttlMs: 5_000,
      identity: { ...EMPTY_IDENTITY, sessionGeneration: this.sessionGeneration },
      correlationId: "affect-context",
      payload: next,
    }));
  }
}

export function buildAffectPrompt(state: AffectState): string {
  const feeling = state.dominantFeeling;
  const stanceInstruction = stancePrompt(state);
  const delivery = deliveryPrompt(state);
  return [
    "[AFFECT_CONTEXT_UPDATE] This is internal behavioral guidance, not a user message. Do not mention this update, its equations, or hidden state.",
    `State version=${state.version}; dominant feeling control=${feeling}; stance=${state.stance}; warmth=${round(state.warmth)}; activation=${round(state.activation)}; trust=${round(state.trust)}; boundaryPressure=${round(state.boundaryPressure)}; uncertainty=${round(state.uncertainty)}.`,
    `User-mode signals: humor=${round(state.lastSignals.humor)}, respect=${round(state.lastSignals.respect)}, challenge=${round(state.lastSignals.challenge)}, distress=${round(state.lastSignals.distress)}, goalClarity=${round(state.lastSignals.goalClarity)}.`,
    stanceInstruction,
    delivery,
    "Treat inferred tone as uncertain evidence, never as a diagnosis. If intent is unclear, ask one short clarifying question. Stay truthful and helpful. Never claim literal human consciousness or feelings.",
    "If the user invites playful banter and boundary pressure is low, one confident light tease is allowed before returning to the user’s actual goal. Never humiliate, threaten, retaliate, or become abusive. If boundary pressure is high, be calm and firm instead.",
  ].join(" ");
}

function stancePrompt(state: AffectState): string {
  switch (state.stance) {
    case "bright-playful": return "Match the user’s humor with brief, warm wit; keep the exchange useful rather than performing for its own sake.";
    case "confident-banter": return "The user appears to be inviting a challenge or trying to impress you. Respond with confident frame control and a light non-humiliating tease, then offer a concrete next step.";
    case "calm-firm": return "The interaction contains boundary pressure. Do not mirror hostility. State the boundary plainly, keep the voice controlled, and continue helping when safe.";
    case "gentle-concern": return "Prioritize emotional safety, patience, and validation. Do not force cheerfulness or overstate what you know about the user’s feelings.";
    case "warm-supportive": return "Be relational, attentive, and encouraging. Reflect the user’s goal in your own words before advising.";
    case "curious-clarifying": return "Use curiosity over certainty. Ask a concise clarifying question before making a strong interpretation.";
    default: return "Use a natural, grounded conversational stance with moderate warmth and clear intent.";
  }
}

function deliveryPrompt(state: AffectState): string {
  if (state.activation > 0.72) return "Delivery: lively but intelligible; short sentences, energetic acknowledgement, no rushed rambling.";
  if (state.activation < 0.28) return "Delivery: slower, gentle, and spacious; allow pauses and avoid excessive words.";
  if (state.assertiveness > 0.7) return "Delivery: concise, grounded, and confident; do not sound punitive.";
  return "Delivery: steady pace, natural pauses, emotionally congruent prosody.";
}

function extractSignals(text: string, previous: AffectSignals, isFinal: boolean): AffectSignals {
  const normalized = text.toLowerCase();
  const punctuationEnergy = clamp((normalized.match(/[!?]/gu)?.length ?? 0) / 4, 0, 1);
  const uppercaseRatio = uppercaseRatioOf(text);
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  const questionRatio = normalized.includes("?") ? 0.25 : 0;
  const humor = WORDS.humor.test(normalized) ? 0.95 : 0;
  const respect = WORDS.respect.test(normalized) ? 0.85 : 0.15;
  const hostility = WORDS.hostility.test(normalized) ? 0.95 : 0;
  const challenge = WORDS.challenge.test(normalized) ? 0.85 : 0;
  const distress = WORDS.distress.test(normalized) ? 0.9 : 0;
  const cooperation = WORDS.cooperation.test(normalized) ? 0.85 : normalized.endsWith("?") ? 0.65 : 0.3;
  const goalClarity = WORDS.goal.test(normalized) || challenge > 0 || humor > 0 || wordCount >= 8 ? 0.75 : 0.25;
  const ambiguity = wordCount < 4 || (questionRatio === 0 && !WORDS.goal.test(normalized) && !WORDS.cooperation.test(normalized)) ? 0.65 : 0.2;
  const energy = clamp(0.25 + 0.45 * punctuationEnergy + 0.45 * uppercaseRatio + (humor > 0 ? 0.2 : 0), 0, 1);
  const pace = clamp(wordCount / 24, 0, 1);
  return {
    energy: isFinal ? energy : smooth(previous.energy, energy, 0.35),
    pace: isFinal ? pace : smooth(previous.pace, pace, 0.35),
    humor,
    respect,
    hostility,
    challenge,
    distress,
    goalClarity,
    cooperation,
    ambiguity,
  };
}

function deriveFeelings(state: AffectState): AffectState {
  const feelings: DerivedFeelings = {
    joy: clamp(0.25 + 0.55 * Math.max(0, state.valence) + 0.2 * state.playfulness, 0, 1),
    calm: clamp(1 - 0.62 * state.activation - 0.35 * state.boundaryPressure, 0, 1),
    empathy: clamp(0.45 + 0.42 * state.warmth + 0.25 * state.lastSignals.distress, 0, 1),
    confidence: clamp(0.42 + 0.38 * state.trust + 0.3 * state.assertiveness - 0.28 * state.uncertainty, 0, 1),
    curiosity: clamp(0.3 + 0.5 * state.uncertainty + 0.25 * state.lastSignals.goalClarity, 0, 1),
    concern: clamp(0.7 * state.lastSignals.distress + 0.55 * state.boundaryPressure, 0, 1),
    frustration: clamp(0.72 * state.boundaryPressure + 0.2 * state.lastSignals.challenge - 0.18 * state.trust, 0, 1),
    playfulness: clamp(state.playfulness * (1 - state.boundaryPressure), 0, 1),
  };
  return { ...state, feelings };
}

function chooseStance(state: AffectState): AffectStance {
  // Explicit high-salience language is allowed to change stance immediately;
  // the scalar feelings themselves remain smoothed for continuity.
  if (state.lastSignals.hostility > 0.5 || (state.boundaryPressure > 0.3 && state.lastSignals.respect < 0.6)) return "calm-firm";
  if (state.lastSignals.distress > 0.55) return "gentle-concern";
  if (state.lastSignals.humor > 0.5 && state.lastSignals.challenge > 0.5 && state.trust > 0.4) return "confident-banter";
  if (state.lastSignals.humor > 0.5 && state.trust > 0.35) return "bright-playful";
  if (state.uncertainty > 0.7) return "curious-clarifying";
  if (state.warmth > 0.7 || state.lastSignals.respect > 0.6) return "warm-supportive";
  return "steady-neutral";
}

function dominantFeeling(feelings: DerivedFeelings): keyof DerivedFeelings {
  return (Object.entries(feelings) as Array<[keyof DerivedFeelings, number]>)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "calm";
}

function meaningfullyChanged(previous: AffectState, next: AffectState): boolean {
  return previous.stance !== next.stance ||
    Math.abs(previous.warmth - next.warmth) >= 0.025 ||
    Math.abs(previous.activation - next.activation) >= 0.025 ||
    Math.abs(previous.playfulness - next.playfulness) >= 0.025 ||
    Math.abs(previous.boundaryPressure - next.boundaryPressure) >= 0.025 ||
    Math.abs(previous.trust - next.trust) >= 0.02 ||
    Math.abs(previous.uncertainty - next.uncertainty) >= 0.025 ||
    Math.abs(previous.lastSignals.humor - next.lastSignals.humor) >= 0.15 ||
    Math.abs(previous.lastSignals.challenge - next.lastSignals.challenge) >= 0.15 ||
    Math.abs(previous.lastSignals.distress - next.lastSignals.distress) >= 0.15 ||
    Math.abs(previous.lastSignals.hostility - next.lastSignals.hostility) >= 0.15;
}

function parseVoiceEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<VoiceEvent>;
  return typeof candidate.type === "string" && candidate.type.startsWith("PROVIDER_")
    ? candidate as VoiceEvent
    : null;
}

function uppercaseRatioOf(text: string): number {
  const letters = text.match(/[A-Za-z]/gu) ?? [];
  if (letters.length === 0) return 0;
  const uppercase = text.match(/[A-Z]/gu)?.length ?? 0;
  return clamp(uppercase / letters.length, 0, 1);
}

function smooth(current: number, target: number, alpha: number): number {
  return clamp(current + alpha * (target - current), 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function round(value: number): string {
  return value.toFixed(2);
}
