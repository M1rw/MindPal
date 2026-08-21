import type { AudioChunk, AudioLane, GenerationIdentity } from "../../core/layer-link";
import type { ProviderAudioPayload } from "../adapter/event-types";
import { int16ToBase64 } from "../transport/base64-utils";
import { createPcm16AudioBuffer, PLAYBACK_SAMPLE_RATE } from "./audio-utils";
import { DEBUG_V3 } from "../../debug/debug-flags";
import type { ProsodyState } from "../prosody/prosody-state";

export const DEBUG_PLAYBACK = DEBUG_V3;
export const TARGET_JITTER_BUFFER_MS = 120;
export const MIN_JITTER_BUFFER_MS = 40;
export const MAIN_GAIN = 1;
export const BACKCHANNEL_GAIN = 0.4;
export const DUCKED_MAIN_GAIN = 0.32;
export const DUCK_RAMP_MS = 20;
export const RESTORE_RAMP_MS = 150;

export type PlaybackState = "IDLE" | "SCHEDULED" | "PLAYING" | "FLUSHED";

export type PlaybackEvent =
  | {
      readonly type: "playback.scheduled";
      readonly chunkId: string;
      readonly lane: AudioLane;
      readonly generationId: string;
      readonly startTime: number;
      readonly endTime: number;
      readonly queueDepthMs: number;
    }
  | { readonly type: "playback.underrun"; readonly queueDepthMs: number }
  | {
      readonly type: "playback.stale_chunk.rejected";
      readonly chunkId: string;
      readonly generationId: string;
      readonly activeGenerationId: string | null;
    }
  | { readonly type: "playback.flushed"; readonly generationId: string }
  | { readonly type: "playback.ducked"; readonly targetGain: number; readonly endTime: number }
  | { readonly type: "playback.restored"; readonly targetGain: number; readonly endTime: number }
  | { readonly type: "playback.error"; readonly reason: string; readonly error?: unknown };

export type PlaybackSnapshot = {
  readonly state: PlaybackState;
  readonly queueDepthMs: number;
  readonly activeGenerationId: string | null;
  readonly mainGain: number;
  readonly backchannelGain: number;
  readonly scheduledSources: number;
};

export type PlaybackManagerOptions = {
  readonly audioContextFactory?: () => AudioContext;
  readonly nowMono?: () => number;
  readonly onEvent?: (event: PlaybackEvent) => void;
  readonly onSnapshot?: (snapshot: PlaybackSnapshot) => void;
};

type ScheduledSource = {
  readonly source: AudioBufferSourceNode;
  readonly generationId: string;
  readonly endTime: number;
};

function isAudioBuffer(value: unknown): value is AudioBuffer {
  return typeof value === "object" && value !== null && typeof (value as AudioBuffer).duration === "number";
}

/**
 * Web Audio playback boundary. Network arrival never calls source.start()
 * directly at wall-clock arrival; all chunks are placed on the AudioContext
 * clock and fenced by playback generation.
 */
export class PlaybackManager {
  private readonly audioContextFactory: () => AudioContext;
  private readonly nowMono: () => number;
  private readonly onEvent: ((event: PlaybackEvent) => void) | undefined;
  private readonly onSnapshot: ((snapshot: PlaybackSnapshot) => void) | undefined;

  private audioContext: AudioContext | null = null;
  private mainGainNode: GainNode | null = null;
  private backchannelGainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private nextStartTime: number | null = null;
  private activeGenerationId: string | null = null;
  private readonly generationOrder = new Map<string, number>();
  private generationCounter = 0;
  private readonly scheduledSources = new Map<string, Set<ScheduledSource>>();
  private sequence = 0;
  private playbackState: PlaybackState = "IDLE";
  private backchannelGainTarget = BACKCHANNEL_GAIN;
  private urgentFadeMs = 150;

  public constructor(options: PlaybackManagerOptions = {}) {
    this.audioContextFactory = options.audioContextFactory ?? (() => new AudioContext());
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.onEvent = options.onEvent;
    this.onSnapshot = options.onSnapshot;
  }

  public async ensureContextResumed(): Promise<AudioContext> {
    const context = this.ensureGraph();
    if (context.state === "suspended") await context.resume();
    return context;
  }

  public async enqueueProviderAudio(
    payload: ProviderAudioPayload,
    identity: GenerationIdentity,
    audioLane: AudioLane = "main",
  ): Promise<boolean> {
    if (payload.sampleRate !== PLAYBACK_SAMPLE_RATE) {
      this.emit({
        type: "playback.error",
        reason: `unsupported provider sample rate ${payload.sampleRate}; expected ${PLAYBACK_SAMPLE_RATE}`,
      });
      return false;
    }
    const bytes = Uint8Array.from(atob(payload.dataBase64), (character) => character.charCodeAt(0));
    const chunk: AudioChunk = {
      chunkId: `audio-chunk-${this.sequence++}`,
      sequence: this.sequence,
      format: "pcm_s16le",
      sampleRate: PLAYBACK_SAMPLE_RATE,
      channels: 1,
      data: bytes.buffer as ArrayBuffer,
      audioLane,
      identity,
    };
    return this.enqueueChunk(chunk, payload.dataBase64);
  }

  public async enqueueChunk(chunk: AudioChunk, dataBase64?: string): Promise<boolean> {
    if (!this.acceptGeneration(chunk.identity.playbackGeneration)) {
      this.emit({
        type: "playback.stale_chunk.rejected",
        chunkId: chunk.chunkId,
        generationId: chunk.identity.playbackGeneration ?? "unassigned",
        activeGenerationId: this.activeGenerationId,
      });
      return false;
    }
    if (chunk.sampleRate !== PLAYBACK_SAMPLE_RATE || chunk.channels !== 1) {
      this.emit({ type: "playback.error", reason: "invalid provider audio format" });
      return false;
    }

    try {
      const context = await this.ensureContextResumed();
      const preloadedBuffer = isAudioBuffer(chunk.decodedAudioBuffer)
        ? chunk.decodedAudioBuffer
        : null;
      const encoded = dataBase64 ?? int16ToBase64(chunk.data);
      const buffer = preloadedBuffer ?? createPcm16AudioBuffer(context, encoded);
      const lane = chunk.audioLane === "backchannel" ? "backchannel" : "main";
      if (lane === "main" && this.urgentFadeMs < 150) this.fadeBackchannelForMainStart(context.currentTime);
      const gainNode = lane === "backchannel" ? this.backchannelGainNode : this.mainGainNode;
      if (!gainNode) throw new Error("playback graph is not initialized");

      const currentTime = context.currentTime;
      const bufferBeforeScheduleMs = this.nextStartTime === null
        ? 0
        : Math.max(0, (this.nextStartTime - currentTime) * 1_000);
      if (this.nextStartTime !== null && bufferBeforeScheduleMs < MIN_JITTER_BUFFER_MS) {
        this.emit({ type: "playback.underrun", queueDepthMs: bufferBeforeScheduleMs });
      }
      const previousChunkEndTime = this.nextStartTime ?? currentTime + TARGET_JITTER_BUFFER_MS / 1_000;
      const startTime = Math.max(currentTime, previousChunkEndTime);
      const endTime = startTime + buffer.duration;
      this.nextStartTime = endTime;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNode);
      const scheduled: ScheduledSource = {
        source,
        generationId: chunk.identity.playbackGeneration ?? "unassigned",
        endTime,
      };
      const generationSources = this.scheduledSources.get(scheduled.generationId) ?? new Set();
      generationSources.add(scheduled);
      this.scheduledSources.set(scheduled.generationId, generationSources);
      source.onended = () => {
        generationSources.delete(scheduled);
        if (generationSources.size === 0) this.scheduledSources.delete(scheduled.generationId);
        if (this.scheduledSources.size === 0) this.playbackState = "IDLE";
        this.emitSnapshot();
      };
      source.start(startTime);
      this.playbackState = "PLAYING";
      this.emit({
        type: "playback.scheduled",
        chunkId: chunk.chunkId,
        lane,
        generationId: scheduled.generationId,
        startTime,
        endTime,
        queueDepthMs: this.queueDepthMs,
      });
      this.debug("[Playback] chunk scheduled", {
        chunkId: chunk.chunkId,
        startTime,
        endTime,
        queueDepthMs: this.queueDepthMs,
      });
      this.emitSnapshot();
      return true;
    } catch (error) {
      this.emit({ type: "playback.error", reason: "audio chunk scheduling failed", error });
      return false;
    }
  }

  public activateGeneration(generationId: string): void {
    if (this.activeGenerationId === generationId) return;
    const previous = this.activeGenerationId;
    if (!this.generationOrder.has(generationId)) {
      this.generationCounter += 1;
      this.generationOrder.set(generationId, this.generationCounter);
    }
    if (previous) this.flush(previous);
    this.activeGenerationId = generationId;
    this.nextStartTime = null;
    this.playbackState = "FLUSHED";
    this.emitSnapshot();
  }

  public flush(generationId: string): void {
    const sources = this.scheduledSources.get(generationId);
    if (sources) {
      for (const scheduled of sources) {
        try {
          scheduled.source.stop();
        } catch (error) {
          this.debug("[Playback] source already stopped during flush", error);
        }
      }
      this.scheduledSources.delete(generationId);
    }
    if (this.activeGenerationId === generationId) {
      this.nextStartTime = null;
      this.playbackState = "FLUSHED";
    }
    this.emit({ type: "playback.flushed", generationId });
    this.debug("[Playback] generation flushed", { generationId });
    this.emitSnapshot();
  }

  public duckMainLane(): void {
    const context = this.ensureGraph();
    const now = context.currentTime;
    const endTime = now + DUCK_RAMP_MS / 1_000;
    const gain = this.mainGainNode?.gain;
    if (!gain) return;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(DUCKED_MAIN_GAIN, endTime);
    this.emit({ type: "playback.ducked", targetGain: DUCKED_MAIN_GAIN, endTime });
    this.emitSnapshot();
  }

  public setSpeakerMuted(muted: boolean): void {
    const context = this.ensureGraph();
    const now = context.currentTime;
    const targetMain = muted ? 0 : MAIN_GAIN;
    const targetBackchannel = muted ? 0 : this.backchannelGainTarget;
    for (const [gainNode, target] of [[this.mainGainNode, targetMain], [this.backchannelGainNode, targetBackchannel]] as const) {
      const gain = gainNode?.gain;
      if (!gain) continue;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(target, now + 0.02);
    }
    this.emitSnapshot();
  }

  public setProsodyState(state: ProsodyState): void {
    const context = this.ensureGraph();
    const now = context.currentTime;
    const quiet = state.emotionalGuess === "sad" || state.energyLevel === "low";
    this.backchannelGainTarget = quiet ? BACKCHANNEL_GAIN * 0.75 : BACKCHANNEL_GAIN;
    this.urgentFadeMs = state.emotionalGuess === "urgent" ? 60 : 150;
    const gain = this.backchannelGainNode?.gain;
    if (gain) {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(this.backchannelGainTarget, now + 0.05);
    }
    this.emitSnapshot();
  }

  public restoreMainLane(): void {
    const context = this.ensureGraph();
    const now = context.currentTime;
    const endTime = now + RESTORE_RAMP_MS / 1_000;
    const gain = this.mainGainNode?.gain;
    if (!gain) return;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(MAIN_GAIN, endTime);
    this.emit({ type: "playback.restored", targetGain: MAIN_GAIN, endTime });
    this.emitSnapshot();
  }

  public get snapshot(): PlaybackSnapshot {
    return {
      state: this.playbackState,
      queueDepthMs: this.queueDepthMs,
      activeGenerationId: this.activeGenerationId,
      mainGain: this.mainGainNode?.gain.value ?? MAIN_GAIN,
      backchannelGain: this.backchannelGainNode?.gain.value ?? BACKCHANNEL_GAIN,
      scheduledSources: Array.from(this.scheduledSources.values()).reduce(
        (total, sources) => total + sources.size,
        0,
      ),
    };
  }

  public get queueDepthMs(): number {
    const context = this.audioContext;
    if (!context || this.nextStartTime === null) return 0;
    return Math.max(0, (this.nextStartTime - context.currentTime) * 1_000);
  }

  public get activeGeneration(): string | null {
    return this.activeGenerationId;
  }

  private acceptGeneration(generationId: string | null): boolean {
    const candidate = generationId ?? "unassigned";
    if (!this.activeGenerationId) {
      this.activeGenerationId = candidate;
      this.generationCounter += 1;
      this.generationOrder.set(candidate, this.generationCounter);
      return true;
    }
    if (candidate === this.activeGenerationId) return true;
    const currentOrder = this.generationOrder.get(this.activeGenerationId) ?? 0;
    const candidateOrder = this.generationOrder.get(candidate);
    if (candidateOrder !== undefined && candidateOrder < currentOrder) return false;
    this.activateGeneration(candidate);
    return true;
  }

  private ensureGraph(): AudioContext {
    if (this.audioContext) return this.audioContext;
    const context = this.audioContextFactory();
    const mainGain = context.createGain();
    const backchannelGain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const analyser = context.createAnalyser();
    mainGain.gain.value = MAIN_GAIN;
    backchannelGain.gain.value = BACKCHANNEL_GAIN;
    mainGain.connect(compressor);
    backchannelGain.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(context.destination);
    this.audioContext = context;
    this.mainGainNode = mainGain;
    this.backchannelGainNode = backchannelGain;
    this.compressorNode = compressor;
    this.analyserNode = analyser;
    return context;
  }

  private fadeBackchannelForMainStart(now: number): void {
    const gain = this.backchannelGainNode?.gain;
    if (!gain) return;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + this.urgentFadeMs / 1_000);
    gain.linearRampToValueAtTime(this.backchannelGainTarget, now + this.urgentFadeMs / 1_000 + 0.12);
  }

  private emit(event: PlaybackEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.debug("[Playback] event handler failed", error);
    }
  }

  private emitSnapshot(): void {
    this.onSnapshot?.(this.snapshot);
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_PLAYBACK && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), message, details ?? "");
    }
  }
}
