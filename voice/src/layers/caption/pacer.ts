import type { GenerationIdentity, LayerLinkEnvelope } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import { AssistantAssembler } from "../transcript/assistant-assembler";
import { DEBUG_V3 } from "../../debug/debug-flags";
import type { TranscriptUpdate } from "../transcript/assembler";

export const DEBUG_TRANSCRIPT = DEBUG_V3;
export const MAX_PENDING_CAPTIONS = 64;

export type CaptionCandidate = {
  readonly text: string;
  readonly identity: GenerationIdentity;
  readonly logicalTurnKey: string;
  readonly revision: number;
  readonly isFinal: boolean;
  readonly receivedAtMono: number;
};

export type CaptionReleased = CaptionCandidate & {
  readonly releasedAtMono: number;
  readonly driftEstimateMs: number;
};

export type CaptionPacerSnapshot = {
  readonly activeAssemblerText: string;
  readonly pendingQueueDepth: number;
  readonly lastReleasedCaption: string | null;
  readonly driftEstimateMs: number;
  readonly closedTurns: number;
  readonly currentPlaybackGeneration: string | null;
};

export type CaptionPacerEvent =
  | { readonly type: "caption.stale.rejected"; readonly reason: string; readonly identity: GenerationIdentity }
  | { readonly type: "caption.released"; readonly caption: CaptionReleased }
  | { readonly type: "caption.snapshot.updated"; readonly snapshot: CaptionPacerSnapshot };

export type CaptionPacerOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly assistantAssembler?: AssistantAssembler;
  readonly nowMono?: () => number;
};

/**
 * Releases assistant captions only after a matching playback scheduling event.
 * It consumes Orchestrator output events and never displays provider text on
 * network arrival alone.
 */
export class CaptionPacer {
  private readonly bus: LayerLinkMessageBus;
  private readonly assistantAssembler: AssistantAssembler;
  private readonly nowMono: () => number;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pending: CaptionCandidate[] = [];
  private readonly closedTurns = new Set<string>();
  private readonly closedTurnAtMono = new Map<string, number>();
  private currentPlaybackGeneration: string | null = null;
  private activeAssemblerText = "";
  private lastReleasedCaption: string | null = null;
  private driftEstimateMs = 0;

  public constructor(options: CaptionPacerOptions) {
    this.bus = options.bus;
    this.assistantAssembler = options.assistantAssembler ?? new AssistantAssembler();
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.unsubscribers.push(
      this.bus.subscribe<unknown>(
        (envelope) => this.handleOutputEnvelope(envelope),
        { topic: "voice.transcript", messageType: "ORCHESTRATOR_OUTPUT_TRANSCRIPT" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleLifecycleEnvelope(envelope),
        { topic: "voice.transcript", messageType: "ORCHESTRATOR_TRANSCRIPT_EVENT" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handlePlaybackEnvelope(envelope),
        { topic: "voice.playback", messageType: "playback.chunk-scheduled" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handlePlaybackEnvelope(envelope),
        { topic: "voice.playback", messageType: "playback.started" },
      ),
    );
    this.emitSnapshot();
  }

  public get snapshot(): CaptionPacerSnapshot {
    return {
      activeAssemblerText: this.activeAssemblerText,
      pendingQueueDepth: this.pending.length,
      lastReleasedCaption: this.lastReleasedCaption,
      driftEstimateMs: this.driftEstimateMs,
      closedTurns: this.closedTurns.size,
      currentPlaybackGeneration: this.currentPlaybackGeneration,
    };
  }

  public dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  public enqueue(candidate: CaptionCandidate): boolean {
    if (this.isStaleOrClosed(candidate.identity, candidate.logicalTurnKey, candidate.receivedAtMono)) {
      this.reject("closed-turn-or-stale-playback-generation", candidate.identity);
      return false;
    }
    if (this.pending.length >= MAX_PENDING_CAPTIONS) {
      const evicted = this.pending.shift();
      if (evicted) this.reject("caption-queue-hard-limit", evicted.identity);
    }
    this.pending.push(candidate);
    this.emitSnapshot();
    return true;
  }

  public closeTurn(identity: GenerationIdentity): void {
    const key = turnKey(identity);
    this.closedTurns.add(key);
    this.closedTurnAtMono.set(key, this.nowMono());
    this.emitSnapshot();
  }

  private handleOutputEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const event = parseOutputEvent(envelope.payload);
    if (!event) return;
    const update = this.assistantAssembler.consume(event);
    if (!update) return;
    const candidate = toCaptionCandidate(update, this.nowMono());
    this.activeAssemblerText = candidate.text;
    this.debug("assistant candidate queued", candidate);
    this.enqueue(candidate);
  }

  private handleLifecycleEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const payload = envelope.payload as { readonly event?: VoiceEvent };
    if (payload.event?.type === "PROVIDER_TURN_COMPLETE") {
      this.closeTurn(payload.event.identity);
    }
  }

  private handlePlaybackEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const event = envelope.payload as {
      readonly generationId?: unknown;
      readonly startTime?: unknown;
      readonly lane?: unknown;
    };
    const generationId = typeof event.generationId === "string" ? event.generationId : envelope.identity.playbackGeneration;
    if (generationId !== null && generationId !== undefined) {
      if (this.currentPlaybackGeneration && isOlderGeneration(generationId, this.currentPlaybackGeneration)) {
        this.reject("stale-playback-generation", envelope.identity);
        return;
      }
      this.currentPlaybackGeneration = generationId;
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        const candidate = this.pending[index];
        if (
          candidate &&
          candidate.identity.playbackGeneration &&
          isOlderGeneration(candidate.identity.playbackGeneration, generationId)
        ) {
          this.pending.splice(index, 1);
          this.reject("stale-playback-generation", candidate.identity);
        }
      }
    }
    if (event.lane === "backchannel") return;
    const candidateIndex = this.pending.findIndex((candidate) => {
      if (candidate.identity.playbackGeneration === null || generationId === undefined) return true;
      return candidate.identity.playbackGeneration === generationId;
    });
    if (candidateIndex < 0) {
      this.emitSnapshot();
      return;
    }
    const [candidate] = this.pending.splice(candidateIndex, 1);
    if (!candidate || this.isStaleOrClosed(candidate.identity, candidate.logicalTurnKey, candidate.receivedAtMono)) {
      if (candidate) this.reject("closed-turn-or-stale-playback-generation", candidate.identity);
      return;
    }
    const releasedAtMono = this.nowMono();
    this.driftEstimateMs = Math.max(0, releasedAtMono - candidate.receivedAtMono);
    if (typeof event.startTime === "number") {
      this.driftEstimateMs = Math.max(0, releasedAtMono - candidate.receivedAtMono);
    }
    const released: CaptionReleased = {
      ...candidate,
      releasedAtMono,
      driftEstimateMs: this.driftEstimateMs,
    };
    this.lastReleasedCaption = released.text;
    this.emit({ type: "caption.released", caption: released });
    this.debug("caption released", released);
    this.emitSnapshot();
  }

  private isStaleOrClosed(
    identity: GenerationIdentity,
    logicalTurn: string,
    receivedAtMono: number,
  ): boolean {
    const closedAt = this.closedTurnAtMono.get(turnKey(identity));
    if (closedAt !== undefined && receivedAtMono > closedAt) return true;
    if (
      this.currentPlaybackGeneration &&
      identity.playbackGeneration &&
      isOlderGeneration(identity.playbackGeneration, this.currentPlaybackGeneration)
    ) {
      return true;
    }
    return false;
  }

  private reject(reason: string, identity: GenerationIdentity): void {
    this.emit({ type: "caption.stale.rejected", reason, identity });
  }

  private emit(event: CaptionPacerEvent): void {
    this.bus.publish(
      createEventEnvelope({
        messageId: `${event.type}-${this.nowMono()}-${Math.random().toString(36).slice(2)}`,
        messageType: event.type,
        sourceLayer: "caption",
        topic: "voice.caption",
        priority: event.type === "caption.stale.rejected" ? "telemetry" : "normal",
        timestampMono: this.nowMono(),
        ttlMs: 2_000,
        identity: {
          sessionGeneration: "caption-layer",
          turnId: null,
          providerResponseId: null,
          playbackGeneration: this.currentPlaybackGeneration,
        },
        correlationId: "caption-pacer",
        payload: event,
      }),
    );
  }

  private emitSnapshot(): void {
    this.emit({ type: "caption.snapshot.updated", snapshot: this.snapshot });
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_TRANSCRIPT && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), `[Transcript/Caption] ${message}`, details ?? "");
    }
  }
}

function parseOutputEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly event?: unknown };
  const event = candidate.event;
  if (typeof event !== "object" || event === null) return null;
  const typed = event as Partial<VoiceEvent>;
  return typed.type === "PROVIDER_OUTPUT_TRANSCRIPT" ? (typed as VoiceEvent) : null;
}

function toCaptionCandidate(update: TranscriptUpdate, receivedAtMono: number): CaptionCandidate {
  return {
    text: update.text,
    identity: update.identity,
    logicalTurnKey: update.logicalTurnKey,
    revision: update.revision,
    isFinal: update.isFinal,
    receivedAtMono,
  };
}

function turnKey(identity: GenerationIdentity): string {
  return `${identity.sessionGeneration}:${identity.turnId ?? "no-turn"}`;
}

function isOlderGeneration(incoming: string, current: string): boolean {
  const incomingNumber = readGenerationNumber(incoming);
  const currentNumber = readGenerationNumber(current);
  if (incomingNumber !== null && currentNumber !== null) return incomingNumber < currentNumber;
  return incoming !== current;
}

function readGenerationNumber(value: string): number | null {
  const match = /(?:^|[-:])(?:session[-:]?)?(\d+)(?:$|[-:])/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}
