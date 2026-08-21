import type { LayerLinkEnvelope } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import {
  backchannelStyleForProsody,
  contextNoteForProsody,
  DEFAULT_PROSODY_STATE,
  type ProsodyContextReason,
  type ProsodySnapshot,
  type ProsodyState,
} from "./prosody-state";

export const PROSODY_CONFIDENCE_THRESHOLD = 0.65;
export const PROSODY_HYSTERESIS_MS = 1_500;
export const PROSODY_NOISE_FLOOR_ALPHA = 0.035;

export type ProsodyAnalyzerOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly nowMono?: () => number;
  readonly confidenceThreshold?: number;
  readonly hysteresisMs?: number;
};

type SignalSummary = {
  readonly energyLevel: ProsodyState["energyLevel"];
  readonly speechRate: ProsodyState["speechRate"];
  readonly pausePattern: ProsodyState["pausePattern"];
  readonly emotionalGuess: ProsodyState["emotionalGuess"];
  readonly confidence: number;
};

/**
 * Local-only prosodic signal layer. It stores timing and scalar signal
 * summaries, never audio bytes or transcript text, and publishes only bounded
 * state/context metadata through LayerLink.
 */
export class ProsodyAnalyzer {
  private readonly bus: LayerLinkMessageBus;
  private readonly nowMono: () => number;
  private readonly confidenceThreshold: number;
  private readonly hysteresisMs: number;
  private readonly unsubscribers: Array<() => void> = [];
  private stateValue: ProsodyState = DEFAULT_PROSODY_STATE;
  private noiseFloorRmsValue = 0.0025;
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private pauseStartedAt: number | null = null;
  private lastTranscriptAt: number | null = null;
  private transcriptWindowStartedAt: number | null = null;
  private transcriptWordCount = 0;
  private lastTranscriptWordCount = 0;
  private interruptionCountValue = 0;
  private abruptUntilMono = 0;
  private candidate: SignalSummary | null = null;
  private candidateSinceMono = 0;
  private lastContextNoteValue: string | null = null;
  private lastContextReasonValue: ProsodyContextReason | null = null;

  public constructor(options: ProsodyAnalyzerOptions) {
    this.bus = options.bus;
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.confidenceThreshold = options.confidenceThreshold ?? PROSODY_CONFIDENCE_THRESHOLD;
    this.hysteresisMs = options.hysteresisMs ?? PROSODY_HYSTERESIS_MS;
    this.unsubscribers.push(
      this.bus.subscribe<unknown>((envelope) => this.handleCaptureFrame(envelope), {
        topic: "voice.capture",
        messageType: "capture.frame",
      }),
      this.bus.subscribe<unknown>((envelope) => this.handleAdapterEvent(envelope), {
        topic: "voice.provider",
        messageType: "adapter.event",
      }),
    );
    this.emitSnapshot();
  }

  public get state(): ProsodyState {
    return this.stateValue;
  }

  public get snapshot(): ProsodySnapshot {
    const now = this.nowMono();
    return {
      state: this.stateValue,
      noiseFloorRms: this.noiseFloorRmsValue,
      lastContextNote: this.lastContextNoteValue,
      lastContextReason: this.lastContextReasonValue,
      backchannelStyle: backchannelStyleForProsody(this.stateValue),
      speechWindowMs: this.speechStartedAt === null ? 0 : Math.max(0, now - this.speechStartedAt),
      transcriptRateWpm: this.transcriptRateWpm(now),
      interruptionCount: this.interruptionCountValue,
    };
  }

  public dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private handleCaptureFrame(envelope: LayerLinkEnvelope<unknown>): void {
    const frame = parseCaptureSignal(envelope.payload);
    if (!frame) return;
    const now = this.nowMono();
    this.updateNoiseFloor(frame.rms, frame.muted);
    const threshold = Math.max(0.008, this.noiseFloorRmsValue * 2.1 + 0.002);
    const speaking = !frame.muted && frame.rms >= threshold;

    if (speaking) {
      if (this.speechStartedAt === null) this.speechStartedAt = now;
      this.lastSpeechAt = now;
      if (this.pauseStartedAt !== null) {
        const pauseMs = Math.max(0, now - this.pauseStartedAt);
        this.pauseStartedAt = null;
        if (pauseMs >= 150 && pauseMs <= 600) this.updateFromSignals(now);
      }
      this.updateFromSignals(now);
    } else {
      if (this.speechStartedAt !== null) {
        if (this.pauseStartedAt === null) this.pauseStartedAt = now;
        this.updateFromSignals(now);
        if (now - this.pauseStartedAt > 800) {
          this.speechStartedAt = null;
          this.lastSpeechAt = null;
          this.pauseStartedAt = null;
          this.updateFromSignals(now);
        }
      } else {
        this.updateFromSignals(now);
      }
    }
    this.emitSnapshot();
  }

  private handleAdapterEvent(envelope: LayerLinkEnvelope<unknown>): void {
    const event = parseVoiceEvent(envelope.payload);
    if (!event) return;
    const now = this.nowMono();
    if (event.type === "PROVIDER_INPUT_TRANSCRIPT") {
      const words = countWords(event.payload.text);
      if (this.transcriptWindowStartedAt === null) this.transcriptWindowStartedAt = now;
      this.transcriptWordCount = Math.max(this.transcriptWordCount, words);
      this.lastTranscriptWordCount = words;
      this.lastTranscriptAt = now;
      this.updateFromSignals(now);
      if (event.payload.isFinal) this.emitContextNote("turn-finalized");
      this.emitSnapshot();
      return;
    }
    if (event.type === "PROVIDER_INTERRUPTED") {
      this.interruptionCountValue += 1;
      this.abruptUntilMono = now + 1_500;
      this.updateFromSignals(now);
      this.emitSnapshot();
      return;
    }
    if (event.type === "PROVIDER_TURN_COMPLETE") {
      this.emitContextNote("turn-finalized");
      this.speechStartedAt = null;
      this.lastSpeechAt = null;
      this.pauseStartedAt = null;
      this.transcriptWindowStartedAt = null;
      this.transcriptWordCount = 0;
      this.lastTranscriptWordCount = 0;
      this.updateFromSignals(now);
      this.emitSnapshot();
    }
  }

  private updateFromSignals(now: number): void {
    const summary = inferSignals({
      noiseFloorRms: this.noiseFloorRmsValue,
      latestRms: this.latestRms,
      speechRateWpm: this.transcriptRateWpm(now),
      pauseMs: this.pauseStartedAt === null ? 0 : Math.max(0, now - this.pauseStartedAt),
      interruptionActive: now < this.abruptUntilMono,
      interruptionCount: this.interruptionCountValue,
      speechActive: this.speechStartedAt !== null && this.pauseStartedAt === null,
      confidenceThreshold: this.confidenceThreshold,
    });
    if (sameSignalSummary(this.candidate, summary) === false) {
      this.candidate = summary;
      this.candidateSinceMono = now;
    }
    if (sameSignalSummary(this.candidate, summary) && now - this.candidateSinceMono < this.hysteresisMs) return;
    if (sameState(this.stateValue, summary)) return;
    const nextState: ProsodyState = {
      ...summary,
      lastChangedAtMono: now,
    };
    this.stateValue = nextState;
    if (summary.confidence >= this.confidenceThreshold) this.emitContextNote("high-confidence-state-change");
    this.bus.publish(createEventEnvelope({
      messageId: `prosody-state-${now}`,
      messageType: "prosody.state.updated",
      sourceLayer: "prosody",
      topic: "voice.prosody",
      priority: "telemetry",
      timestampMono: now,
      ttlMs: 10_000,
      identity: {
        sessionGeneration: "prosody",
        turnId: null,
        providerResponseId: null,
        playbackGeneration: null,
      },
      correlationId: "prosody-analyzer",
      payload: nextState,
    }));
    this.emitSnapshot();
  }

  private emitContextNote(reason: ProsodyContextReason): void {
    const now = this.nowMono();
    const note = contextNoteForProsody(this.stateValue);
    if (!note || note === this.lastContextNoteValue && reason === "high-confidence-state-change") return;
    this.lastContextNoteValue = note;
    this.lastContextReasonValue = reason;
    this.bus.publish(createEventEnvelope({
      messageId: `prosody-context-${now}`,
      messageType: "prosody.context.note",
      sourceLayer: "prosody",
      targetLayer: "transport",
      topic: "voice.transport",
      priority: "high",
      timestampMono: now,
      ttlMs: 5_000,
      identity: {
        sessionGeneration: "prosody",
        turnId: null,
        providerResponseId: null,
        playbackGeneration: null,
      },
      correlationId: "prosody-context",
      payload: { note, reason, state: this.stateValue },
    }));
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const now = this.nowMono();
    this.bus.publish(createEventEnvelope({
      messageId: `prosody-snapshot-${now}-${Math.random().toString(36).slice(2)}`,
      messageType: "prosody.snapshot.updated",
      sourceLayer: "prosody",
      topic: "voice.prosody",
      priority: "telemetry",
      timestampMono: now,
      ttlMs: 10_000,
      identity: {
        sessionGeneration: "prosody",
        turnId: null,
        providerResponseId: null,
        playbackGeneration: null,
      },
      correlationId: "prosody-analyzer",
      payload: this.snapshot,
    }));
  }

  private latestRms = 0;

  private updateNoiseFloor(rms: number, muted: boolean): void {
    this.latestRms = rms;
    if (muted || rms < Math.max(0.015, this.noiseFloorRmsValue * 2.2)) {
      this.noiseFloorRmsValue = this.noiseFloorRmsValue * (1 - PROSODY_NOISE_FLOOR_ALPHA) + rms * PROSODY_NOISE_FLOOR_ALPHA;
      this.noiseFloorRmsValue = Math.max(0.0001, Math.min(0.05, this.noiseFloorRmsValue));
    }
  }

  private transcriptRateWpm(now: number): number {
    if (this.transcriptWindowStartedAt === null || this.transcriptWordCount <= 0) return 0;
    const elapsedMs = Math.max(1_000, now - this.transcriptWindowStartedAt);
    return (this.transcriptWordCount / elapsedMs) * 60_000;
  }
}

function inferSignals(input: {
  readonly noiseFloorRms: number;
  readonly latestRms: number;
  readonly speechRateWpm: number;
  readonly pauseMs: number;
  readonly interruptionActive: boolean;
  readonly interruptionCount: number;
  readonly speechActive: boolean;
  readonly confidenceThreshold: number;
}): SignalSummary {
  const ratio = input.latestRms / Math.max(input.noiseFloorRms, 0.001);
  const energyLevel: ProsodyState["energyLevel"] = ratio < 3 ? "low" : ratio < 8 ? "normal" : ratio < 14 ? "high" : "very_high";
  const speechRate: ProsodyState["speechRate"] = input.speechRateWpm <= 0 || input.speechRateWpm < 90
    ? "slow"
    : input.speechRateWpm < 180 ? "normal" : input.speechRateWpm < 260 ? "fast" : "very_fast";
  const pausePattern: ProsodyState["pausePattern"] = input.interruptionActive
    ? "abrupt"
    : input.pauseMs > 600 ? "hesitant"
      : input.pauseMs >= 150 ? "natural"
        : input.speechActive ? "continuous" : "hesitant";

  let emotionalGuess: ProsodyState["emotionalGuess"] = "neutral";
  let confidence = 0.35;
  if (input.interruptionCount >= 2 && energyLevel === "very_high" && (speechRate === "fast" || speechRate === "very_fast")) {
    emotionalGuess = "angry";
    confidence = 0.78;
  } else if ((energyLevel === "high" || energyLevel === "very_high") && (speechRate === "fast" || speechRate === "very_fast")) {
    emotionalGuess = input.interruptionActive ? "urgent" : "frustrated";
    confidence = input.interruptionActive ? 0.76 : 0.69;
  } else if ((energyLevel === "high" || energyLevel === "very_high") && speechRate === "very_fast") {
    emotionalGuess = "excited";
    confidence = 0.68;
  } else if (energyLevel === "low" && (pausePattern === "hesitant" || speechRate === "slow")) {
    emotionalGuess = "sad";
    confidence = 0.56;
  } else if (energyLevel !== "very_high" && pausePattern === "hesitant") {
    emotionalGuess = "neutral";
    confidence = 0.66;
  } else if (energyLevel === "low" && input.speechActive) {
    emotionalGuess = "calm";
    confidence = 0.64;
  }
  if (confidence < input.confidenceThreshold) emotionalGuess = "neutral";
  return { energyLevel, speechRate, pausePattern, emotionalGuess, confidence };
}

function parseCaptureSignal(value: unknown): { readonly rms: number; readonly muted: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly rms?: unknown; readonly muted?: unknown };
  return typeof candidate.rms === "number" && Number.isFinite(candidate.rms) && typeof candidate.muted === "boolean"
    ? { rms: Math.max(0, candidate.rms), muted: candidate.muted }
    : null;
}

function parseVoiceEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<VoiceEvent>;
  return typeof candidate.type === "string" && candidate.type.startsWith("PROVIDER_") ? candidate as VoiceEvent : null;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function sameSignalSummary(left: SignalSummary | null, right: SignalSummary): boolean {
  return Boolean(left && left.energyLevel === right.energyLevel && left.speechRate === right.speechRate && left.pausePattern === right.pausePattern && left.emotionalGuess === right.emotionalGuess);
}

function sameState(state: ProsodyState, summary: SignalSummary): boolean {
  return state.energyLevel === summary.energyLevel && state.speechRate === summary.speechRate && state.pausePattern === summary.pausePattern && state.emotionalGuess === summary.emotionalGuess && Math.abs(state.confidence - summary.confidence) < 0.01;
}
