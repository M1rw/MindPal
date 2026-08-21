import type {
  AudioFrame,
  BackchannelCueIdentity,
  GenerationIdentity,
  LayerLinkEnvelope,
} from "../../core/layer-link";
import {
  createEventEnvelope,
  LayerLinkMessageBus,
} from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import type { PlaybackSnapshot } from "../playback/playback-manager";
import type { CueProvider } from "./cue-provider";
import type { GeneratedCue, TtsEmotion, TtsGenerationSource, TtsProviderState } from "../../integration/tts-endpoint-contract";
import { DEFAULT_PROSODY_STATE, type ProsodyState } from "../prosody/prosody-state";
import { DEBUG_V3 } from "../../debug/debug-flags";

export const DEBUG_CONDUCTOR = DEBUG_V3;
export const MIN_CONTINUOUS_SPEECH_MS = 2_500;
export const NATURAL_PAUSE_MIN_MS = 150;
export const NATURAL_PAUSE_MAX_MS = 600;
export const TURN_END_SILENCE_MS = 800;
export const CUE_COOLDOWN_MS = 4_000;
export const CUE_WINDOW_MS = 30_000;
export const MAX_CUES_PER_WINDOW = 3;
export const SPEECH_RMS_THRESHOLD = 0.02;
export const PREDICTIVE_PREFETCH_TRIGGER_MS = 150;
export const PREDICTIVE_PREFETCH_APPROVAL_MS = 600;

export type ConductorState = "IDLE" | "MONITORING" | "COOLDOWN" | "SUPPRESSED";

export type SuppressionReason =
  | "main-lane-speaking"
  | "silence-over-800ms"
  | "turn-complete"
  | "final-transcript"
  | "cooldown"
  | "window-limit"
  | "speech-too-short"
  | "pause-too-long"
  | "not-natural-pause";

export type BackchannelCueRequestPayload =
  | {
      readonly cueText: string;
      readonly delivery: "gemini-native";
      readonly cueIdentity: BackchannelCueIdentity;
      readonly reason: "natural-pause";
    }
  | {
      readonly cue: ReturnType<CueProvider["createCue"]>;
      readonly cueText: string;
      readonly delivery: "prebuilt-audio";
      readonly cueIdentity: BackchannelCueIdentity;
      readonly reason: "natural-pause";
    };

export type ConductorEvent =
  | { readonly type: "backchannel.state.changed"; readonly state: ConductorState }
  | {
      readonly type: "backchannel.cue.approved";
      readonly cueId: string;
      readonly cooldownUntilMono: number;
    }
  | { readonly type: "backchannel.cue.suppressed"; readonly reason: SuppressionReason }
  | { readonly type: "backchannel.snapshot.updated"; readonly snapshot: ConductorSnapshot };

export type PendingCueBufferStatus = "empty" | "generating" | "ready";

export type PredictiveCueProvider = CueProvider & {
  readonly generate: (options: {
    readonly cueText: string;
    readonly voicePersona: string;
    readonly emotion: TtsEmotion;
    readonly identity: GenerationIdentity;
    readonly cueId: string;
  }) => Promise<GeneratedCue>;
  readonly snapshot?: { readonly state: TtsProviderState };
};

type PendingCue = {
  readonly cueText: string;
  readonly identity: GenerationIdentity;
  readonly cueId: string;
  generated: GeneratedCue | null;
  discarded: boolean;
};

export type ConductorSnapshot = {
  readonly state: ConductorState;
  readonly cooldownRemainingMs: number;
  readonly cuesTriggered: number;
  readonly cuesInRollingWindow: number;
  readonly lastSuppressionReason: SuppressionReason | null;
  readonly continuousSpeechMs: number;
  readonly pauseMs: number;
  readonly mainLaneSpeaking: boolean;
  readonly pendingCueBufferStatus: PendingCueBufferStatus;
  readonly predictivePrefetchLatencyMs: number | null;
  readonly ttsProviderState: TtsProviderState;
  readonly lastCueSource: TtsGenerationSource | null;
};

export type BackchannelConductorOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly cueProvider: CueProvider;
  readonly nowMono?: () => number;
  readonly identity?: GenerationIdentity;
  readonly speechRmsThreshold?: number;
  readonly voicePersona?: string;
  readonly emotion?: TtsEmotion;
  readonly nativeGeminiCues?: boolean;
  readonly cueTextSelector?: (cueIndex: number) => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * LayerLink-only backchannel policy engine. It observes capture, provider, and
 * playback envelopes and emits a playback command; it never imports or calls
 * PlaybackManager directly.
 */
export class BackchannelConductor {
  private readonly bus: LayerLinkMessageBus;
  private readonly cueProvider: CueProvider;
  private readonly nowMono: () => number;
  private readonly identity: GenerationIdentity;
  private readonly speechRmsThreshold: number;
  private readonly voicePersona: string;
  private readonly emotion: TtsEmotion;
  private readonly nativeGeminiCues: boolean;
  private readonly cueTextSelector: (cueIndex: number) => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly predictiveProvider: PredictiveCueProvider | null;
  private readonly unsubscribers: Array<() => void> = [];
  private stateValue: ConductorState = "IDLE";
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private pauseStartedAt: number | null = null;
  private cooldownUntilMono = 0;
  private cueCounter = 0;
  private cuesTriggered = 0;
  private cueTimes: number[] = [];
  private lastSuppressionReason: SuppressionReason | null = null;
  private mainLaneSpeaking = false;
  private turnComplete = false;
  private pendingCue: PendingCue | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private prefetchLatencyMs: number | null = null;
  private lastCueSourceValue: TtsGenerationSource | null = null;
  private prosodyState: ProsodyState = DEFAULT_PROSODY_STATE;

  public constructor(options: BackchannelConductorOptions) {
    this.bus = options.bus;
    this.cueProvider = options.cueProvider;
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.identity = options.identity ?? {
      sessionGeneration: "backchannel-session",
      turnId: null,
      providerResponseId: null,
      playbackGeneration: null,
    };
    this.speechRmsThreshold = options.speechRmsThreshold ?? SPEECH_RMS_THRESHOLD;
    this.voicePersona = options.voicePersona ?? "Kore";
    this.emotion = options.emotion ?? "neutral";
    this.nativeGeminiCues = options.nativeGeminiCues ?? false;
    this.cueTextSelector = options.cueTextSelector ?? ((cueIndex) => ["mhm", "yeah", "aha", "right"][cueIndex % 4] ?? "mhm");
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.predictiveProvider = !this.nativeGeminiCues && isPredictiveCueProvider(this.cueProvider) ? this.cueProvider : null;

    this.unsubscribers.push(
      this.bus.subscribe<unknown>(
        (envelope) => this.handleCaptureFrame(envelope),
        { topic: "voice.capture", messageType: "capture.frame" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleProviderEnvelope(envelope),
        { topic: "voice.provider", messageType: "adapter.event" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handlePlaybackEnvelope(envelope),
        { topic: "voice.playback", messageType: "playback.state" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleProsodyEnvelope(envelope),
        { topic: "voice.prosody", messageType: "prosody.state.updated" },
      ),
    );
    this.emitSnapshot();
  }

  public get state(): ConductorState {
    return this.stateValue;
  }

  public get currentProsody(): ProsodyState {
    return this.prosodyState;
  }

  public get snapshot(): ConductorSnapshot {
    const now = this.nowMono();
    return {
      state: this.stateValue,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMono - now),
      cuesTriggered: this.cuesTriggered,
      cuesInRollingWindow: this.activeCueTimes(now).length,
      lastSuppressionReason: this.lastSuppressionReason,
      continuousSpeechMs: this.continuousSpeechMs(now),
      pauseMs: this.pauseMs(now),
      mainLaneSpeaking: this.mainLaneSpeaking,
      pendingCueBufferStatus: this.pendingCue?.generated ? "ready" : this.pendingCue ? "generating" : "empty",
      predictivePrefetchLatencyMs: this.prefetchLatencyMs,
      ttsProviderState: this.predictiveProvider?.snapshot?.state ?? "idle",
      lastCueSource: this.lastCueSourceValue,
    };
  }

  public dispose(): void {
    this.clearPauseTimer();
    this.discardPendingCue();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private handleCaptureFrame(envelope: LayerLinkEnvelope<unknown>): void {
    const frame = parseAudioFrame(envelope.payload);
    if (!frame) return;
    const now = this.nowMono();
    const speaking = !frame.muted && frame.rms >= this.speechRmsThreshold;

    if (speaking) {
      const pauseDuration = this.pauseMs(now);
      const hadPause = this.pauseStartedAt !== null;
      if (this.speechStartedAt === null || this.turnComplete) {
        this.speechStartedAt = now;
        this.turnComplete = false;
        this.setState("IDLE");
      }
      this.lastSpeechAt = now;
      this.pauseStartedAt = null;

      if (hadPause) {
        if (this.predictiveProvider) {
          this.discardPendingCue();
          this.clearPauseTimer();
        } else {
          this.evaluatePause(pauseDuration, now, envelope.identity);
        }
      }
      if (
        this.continuousSpeechMs(now) > MIN_CONTINUOUS_SPEECH_MS &&
        now >= this.cooldownUntilMono &&
        this.stateValue !== "COOLDOWN"
      ) {
        this.setState("MONITORING");
      }
      this.debug("speech frame", {
        rms: frame.rms,
        continuousSpeechMs: this.continuousSpeechMs(now),
        pauseDuration,
      });
      this.emitSnapshot();
      return;
    }

    if (this.speechStartedAt !== null && this.pauseStartedAt === null) {
      this.pauseStartedAt = now;
      if (this.predictiveProvider) this.schedulePredictivePrefetch(now, envelope.identity);
    }
    const silenceMs = this.pauseMs(now);
    if (this.pauseStartedAt !== null && silenceMs > TURN_END_SILENCE_MS) {
      this.discardPendingCue();
      this.clearPauseTimer();
      this.suppress("silence-over-800ms");
      this.speechStartedAt = null;
      this.lastSpeechAt = null;
      this.pauseStartedAt = null;
    }
    this.emitSnapshot();
  }

  private handleProviderEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const event = parseVoiceEvent(envelope.payload);
    const eventType = event?.type ?? envelope.messageType;
    if (eventType === "PROVIDER_TURN_COMPLETE") {
      this.discardPendingCue();
      this.clearPauseTimer();
      this.turnComplete = true;
      this.speechStartedAt = null;
      this.lastSpeechAt = null;
      this.pauseStartedAt = null;
      this.suppress("turn-complete");
    } else if (
      eventType === "PROVIDER_INPUT_TRANSCRIPT" &&
      isFinalTranscriptEvent(event)
    ) {
      this.discardPendingCue();
      this.clearPauseTimer();
      this.suppress("final-transcript");
    }
  }

  private handleProsodyEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    if (!isProsodyState(envelope.payload)) return;
    this.prosodyState = envelope.payload;
    this.emitSnapshot();
  }

  private handlePlaybackEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    if (
      envelope.messageType === "playback.snapshot.updated" ||
      envelope.messageType === "playback.state"
    ) {
      const snapshot = parsePlaybackSnapshot(envelope.payload);
      if (snapshot) {
        this.mainLaneSpeaking = snapshot.state === "PLAYING" && snapshot.mainGain > 0;
        if (this.mainLaneSpeaking) {
          this.discardPendingCue();
          this.clearPauseTimer();
        }
        this.emitSnapshot();
      }
      return;
    }
    if (envelope.messageType === "playback.scheduled") {
      const event = envelope.payload as { readonly lane?: string };
      if (event.lane === "main") {
      this.mainLaneSpeaking = true;
      this.discardPendingCue();
      this.clearPauseTimer();
    }
    }
    if (envelope.messageType === "playback.flushed") {
      this.mainLaneSpeaking = false;
    }
  }

  private schedulePredictivePrefetch(pauseStartedAt: number, envelopeIdentity: GenerationIdentity): void {
    this.clearPauseTimer();
    this.discardPendingCue();
    const pending: PendingCue = {
      cueText: this.selectCueText(),
      identity: envelopeIdentity,
      cueId: `prefetch-cue-${this.cueCounter + 1}`,
      generated: null,
      discarded: false,
    };
    this.pendingCue = pending;
    this.emitSnapshot();
    this.pauseTimer = this.setTimer(() => {
      this.pauseTimer = null;
      if (pending.discarded || this.pendingCue !== pending || this.mainLaneSpeaking) return;
      const prefetchStartedAt = this.nowMono();
      void this.predictiveProvider?.generate({
        cueText: pending.cueText,
        voicePersona: this.voicePersona,
        emotion: this.ttsEmotionForProsody(),
        identity: pending.identity,
        cueId: pending.cueId,
      }).then((generated) => {
        if (pending.discarded || this.pendingCue !== pending) return;
        pending.generated = generated;
        this.prefetchLatencyMs = Math.max(0, this.nowMono() - prefetchStartedAt);
        this.emitSnapshot();
      }).catch((error: unknown) => {
        if (pending.discarded || this.pendingCue !== pending) return;
        this.prefetchLatencyMs = Math.max(0, this.nowMono() - prefetchStartedAt);
        this.debug("predictive TTS prefetch failed", error);
        this.emitSnapshot();
      });
      this.emitSnapshot();
      this.pauseTimer = this.setTimer(
        () => this.approvePrefetchedCue(),
        this.pauseApprovalMs() - PREDICTIVE_PREFETCH_TRIGGER_MS,
      );
      void pauseStartedAt;
    }, PREDICTIVE_PREFETCH_TRIGGER_MS);
  }

  private approvePrefetchedCue(): void {
    this.pauseTimer = null;
    const pending = this.pendingCue;
    if (!pending || pending.discarded) return;
    const now = this.nowMono();
    const pauseDuration = this.pauseMs(now);
    if (pauseDuration > this.pauseApprovalMs() || this.mainLaneSpeaking) {
      this.discardPendingCue();
      this.suppress(this.mainLaneSpeaking ? "main-lane-speaking" : "pause-too-long");
      return;
    }
    if (!pending.generated) {
      this.discardPendingCue();
      this.suppress("pause-too-long");
      return;
    }
    if ((this.prosodyState.emotionalGuess === "angry" || this.prosodyState.emotionalGuess === "frustrated") &&
      (pauseDuration < 300 || this.prosodyState.confidence < 0.7)) {
      this.discardPendingCue();
      this.suppress("not-natural-pause");
      return;
    }
    if (this.continuousSpeechMs(now) <= MIN_CONTINUOUS_SPEECH_MS) {
      this.discardPendingCue();
      this.suppress("speech-too-short");
      return;
    }
    if (now < this.cooldownUntilMono) {
      this.discardPendingCue();
      this.suppress("cooldown");
      return;
    }
    if (this.activeCueTimes(now).length >= MAX_CUES_PER_WINDOW) {
      this.discardPendingCue();
      this.suppress("window-limit");
      return;
    }
    const generated = pending.generated;
    this.pendingCue = null;
    this.approveCue(now, pending.identity, generated);
  }

  private discardPendingCue(): void {
    if (this.pendingCue) this.pendingCue.discarded = true;
    this.pendingCue = null;
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer) this.clearTimer(this.pauseTimer);
    this.pauseTimer = null;
  }

  private selectCueText(): string {
    switch (this.prosodyState.emotionalGuess) {
      case "excited": return "yeah";
      case "urgent":
      case "frustrated":
      case "angry":
      case "sad": return "mhm";
      default: return this.cueTextSelector(this.cueCounter);
    }
  }

  private ttsEmotionForProsody(): TtsEmotion {
    if (this.prosodyState.confidence < 0.65) return this.emotion;
    switch (this.prosodyState.emotionalGuess) {
      case "sad": return "soft";
      case "frustrated":
      case "angry":
      case "urgent": return "concerned";
      case "excited": return "attentive";
      case "calm": return "calm";
      default: return this.emotion;
    }
  }

  private pauseApprovalMs(): number {
    if (this.prosodyState.emotionalGuess === "urgent") return 450;
    if (this.prosodyState.pausePattern === "hesitant") return 750;
    return PREDICTIVE_PREFETCH_APPROVAL_MS;
  }

  private cooldownMs(): number {
    return this.prosodyState.emotionalGuess === "urgent" && this.prosodyState.confidence >= 0.7
      ? 3_000
      : CUE_COOLDOWN_MS;
  }

  private evaluatePause(
    pauseDuration: number,
    now: number,
    envelopeIdentity: GenerationIdentity,
  ): void {
    this.debug("eligibility check", {
      pauseDuration,
      continuousSpeechMs: this.continuousSpeechMs(now),
      mainLaneSpeaking: this.mainLaneSpeaking,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMono - now),
      cuesInRollingWindow: this.activeCueTimes(now).length,
    });
    if (this.continuousSpeechMs(now) <= MIN_CONTINUOUS_SPEECH_MS) {
      this.suppress("speech-too-short");
      return;
    }
    if (pauseDuration < NATURAL_PAUSE_MIN_MS) {
      this.suppress("not-natural-pause");
      return;
    }
    if (pauseDuration > NATURAL_PAUSE_MAX_MS) {
      this.suppress("pause-too-long");
      return;
    }
    if (this.mainLaneSpeaking) {
      this.suppress("main-lane-speaking");
      return;
    }
    if (now < this.cooldownUntilMono) {
      this.suppress("cooldown");
      return;
    }
    if (this.activeCueTimes(now).length >= MAX_CUES_PER_WINDOW) {
      this.suppress("window-limit");
      return;
    }
    this.approveCue(now, envelopeIdentity);
  }

  private approveCue(now: number, envelopeIdentity: GenerationIdentity, generated?: GeneratedCue): void {
    const cueId = `backchannel-cue-${++this.cueCounter}`;
    const identity: GenerationIdentity = {
      ...this.identity,
      sessionGeneration: envelopeIdentity.sessionGeneration || this.identity.sessionGeneration,
      turnId: envelopeIdentity.turnId,
      providerResponseId: envelopeIdentity.providerResponseId,
      playbackGeneration: envelopeIdentity.playbackGeneration,
    };
    const expiresAtMono = now + 1_500;
    const cueIdentity: BackchannelCueIdentity = {
      ...identity,
      cueId,
      cueSource: this.nativeGeminiCues ? "native" : generated ? sourceToCueSource(generated.source) : "local-audio",
      cueLane: "backchannel",
      createdAtMono: now,
      expiresAtMono,
    };
    if (generated) this.lastCueSourceValue = generated.source;
    const request: BackchannelCueRequestPayload = this.nativeGeminiCues
      ? {
          cueText: this.selectCueText(),
          delivery: "gemini-native",
          cueIdentity,
          reason: "natural-pause",
        }
      : {
          cue: generated
            ? { ...generated.chunk, chunkId: cueId, identity }
            : this.cueProvider.createCue(identity, cueId),
          cueText: this.selectCueText(),
          delivery: "prebuilt-audio",
          cueIdentity,
          reason: "natural-pause",
        };
    this.bus.publish(
      createEventEnvelope({
        messageId: `${cueId}-request`,
        messageType: "BACKCHANNEL_CUE_REQUESTED",
        sourceLayer: "backchannel",
        targetLayer: "playback",
        topic: "voice.playback",
        priority: "high",
        timestampMono: now,
        ttlMs: 1_500,
        identity,
        correlationId: cueId,
        payload: request,
      }),
    );
    this.cooldownUntilMono = now + this.cooldownMs();
    this.clearPauseTimer();
    this.cueTimes.push(now);
    this.cuesTriggered += 1;
    this.lastSuppressionReason = null;
    this.setState("COOLDOWN");
    this.emit({ type: "backchannel.cue.approved", cueId, cooldownUntilMono: this.cooldownUntilMono });
    this.debug("cue approved", { cueId, cooldownUntilMono: this.cooldownUntilMono });
    this.emitSnapshot();
  }

  private suppress(reason: SuppressionReason): void {
    this.lastSuppressionReason = reason;
    this.setState("SUPPRESSED");
    this.emit({ type: "backchannel.cue.suppressed", reason });
    this.debug("cue suppressed", { reason });
  }

  private activeCueTimes(now: number): number[] {
    this.cueTimes = this.cueTimes.filter((time) => now - time < CUE_WINDOW_MS);
    return this.cueTimes;
  }

  private continuousSpeechMs(now: number): number {
    return this.speechStartedAt === null ? 0 : Math.max(0, now - this.speechStartedAt);
  }

  private pauseMs(now: number): number {
    return this.pauseStartedAt === null ? 0 : Math.max(0, now - this.pauseStartedAt);
  }

  private setState(state: ConductorState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit({ type: "backchannel.state.changed", state });
  }

  private emit(event: ConductorEvent): void {
    this.bus.publish(
      createEventEnvelope({
        messageId: `${event.type}-${this.nowMono()}-${Math.random().toString(36).slice(2)}`,
        messageType: event.type,
        sourceLayer: "backchannel",
        topic: "voice.backchannel",
        priority: "telemetry",
        timestampMono: this.nowMono(),
        ttlMs: 1_000,
        identity: this.identity,
        correlationId: "backchannel-conductor",
        payload: event,
      }),
    );
  }

  private emitSnapshot(): void {
    this.emit({ type: "backchannel.snapshot.updated", snapshot: this.snapshot });
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_CONDUCTOR && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), `[Conductor] ${message}`, details ?? "");
    }
  }
}

function isProsodyState(value: unknown): value is ProsodyState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProsodyState>;
  return (candidate.energyLevel === "low" || candidate.energyLevel === "normal" || candidate.energyLevel === "high" || candidate.energyLevel === "very_high") &&
    (candidate.speechRate === "slow" || candidate.speechRate === "normal" || candidate.speechRate === "fast" || candidate.speechRate === "very_fast") &&
    (candidate.pausePattern === "continuous" || candidate.pausePattern === "natural" || candidate.pausePattern === "hesitant" || candidate.pausePattern === "abrupt") &&
    typeof candidate.emotionalGuess === "string" &&
    typeof candidate.confidence === "number" &&
    typeof candidate.lastChangedAtMono === "number";
}

function sourceToCueSource(source: TtsGenerationSource): BackchannelCueIdentity["cueSource"] {
  return source === "network" || source === "local" || source === "fallback" ? "realtime-tts" : "local-audio";
}

function isPredictiveCueProvider(value: CueProvider): value is PredictiveCueProvider {
  return typeof (value as Partial<PredictiveCueProvider>).generate === "function";
}

function parseAudioFrame(value: unknown): AudioFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AudioFrame>;
  if (
    typeof candidate.rms !== "number" ||
    typeof candidate.muted !== "boolean" ||
    candidate.sampleRate !== 16_000 ||
    candidate.channels !== 1 ||
    candidate.format !== "pcm_s16le" ||
    candidate.durationMs !== 20
  ) {
    return null;
  }
  return candidate as AudioFrame;
}

function isFinalTranscriptEvent(
  event: VoiceEvent | null,
): event is Extract<VoiceEvent, { type: "PROVIDER_INPUT_TRANSCRIPT" }> {
  return event?.type === "PROVIDER_INPUT_TRANSCRIPT" && event.payload.isFinal === true;
}

function parseVoiceEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<VoiceEvent>;
  return typeof candidate.type === "string" && candidate.type.startsWith("PROVIDER_")
    ? (candidate as VoiceEvent)
    : null;
}

function parsePlaybackSnapshot(value: unknown): PlaybackSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PlaybackSnapshot>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.mainGain !== "number" ||
    typeof candidate.queueDepthMs !== "number"
  ) {
    return null;
  }
  return candidate as PlaybackSnapshot;
}
