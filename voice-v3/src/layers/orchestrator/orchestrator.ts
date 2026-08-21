import type {
  GenerationIdentity,
  LayerLinkEnvelope,
  OperationIdentity,
} from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import type { BackchannelCueRequestPayload } from "../backchannel/conductor";
import {
  type OrchestratorState,
  transitionState,
  type OrchestratorTransition,
} from "./state-machine";
import { DEBUG_V3 } from "../../debug/debug-flags";

export const DEBUG_ORCHESTRATOR = DEBUG_V3;

export type OrchestratorSnapshot = {
  readonly state: OrchestratorState;
  readonly identity: GenerationIdentity;
  readonly operationId: string | null;
  readonly greetingSent: boolean;
  readonly providerResponseClosed: boolean;
  readonly staleEventsRejected: number;
};

export type OrchestratorDiagnostic = {
  readonly type: "ORCHESTRATOR_STALE_REJECTED";
  readonly reason:
    | "stale-session-generation"
    | "stale-turn-id"
    | "stale-playback-generation"
    | "closed-response-boundary"
    | "stale-operation-id";
  readonly eventType: string;
  readonly identity: GenerationIdentity;
};

export type OrchestratorOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly nowMono?: () => number;
  readonly sessionGeneration?: string;
};

/**
 * Central Voice V3 middleware. It owns every active identity and is the only
 * component allowed to forward provider/cue artifacts to transcript, playback,
 * operation, or recovery topics.
 */
export class VoiceOrchestrator {
  private readonly bus: LayerLinkMessageBus;
  private readonly nowMono: () => number;
  private readonly unsubscribers: Array<() => void> = [];
  private stateValue: OrchestratorState = "IDLE";
  private sessionGeneration: string;
  private turnId: string | null = null;
  private providerResponseId: string | null = null;
  private playbackGeneration: string | null = null;
  private operationId: string | null = null;
  private greetingSentValue = false;
  private providerResponseClosedValue = false;
  private nativeCuePending = false;
  private staleEventsRejectedValue = 0;
  private sessionCounter = 1;
  private turnCounter = 0;
  private playbackCounter = 0;
  private operationCounter = 0;
  private readonly closedTurnIds = new Set<string>();
  private readonly turnOrder = new Map<string, number>();

  public constructor(options: OrchestratorOptions) {
    this.bus = options.bus;
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.sessionGeneration = options.sessionGeneration ?? "session-1";
    this.sessionCounter = readGenerationNumber(this.sessionGeneration) ?? 1;

    this.unsubscribers.push(
      this.bus.subscribe<unknown>(
        (envelope) => this.handleProviderEnvelope(envelope),
        { topic: "voice.provider", messageType: "adapter.event" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleBackchannelEnvelope(envelope),
        { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleBackchannelEnvelope(envelope),
        { topic: "voice.backchannel" },
      ),
      this.bus.subscribe<unknown>(
        (envelope) => this.handleOperationResult(envelope),
        { topic: "voice.operation" },
      ),
    );
    this.emitSnapshot();
  }

  public get snapshot(): OrchestratorSnapshot {
    return {
      state: this.stateValue,
      identity: this.identity,
      operationId: this.operationId,
      greetingSent: this.greetingSentValue,
      providerResponseClosed: this.providerResponseClosedValue,
      staleEventsRejected: this.staleEventsRejectedValue,
    };
  }

  public get identity(): GenerationIdentity {
    return {
      sessionGeneration: this.sessionGeneration,
      turnId: this.turnId,
      providerResponseId: this.providerResponseId,
      playbackGeneration: this.playbackGeneration,
    };
  }

  public get state(): OrchestratorState {
    return this.stateValue;
  }

  public get greetingSent(): boolean {
    return this.greetingSentValue;
  }

  public get staleEventsRejected(): number {
    return this.staleEventsRejectedValue;
  }

  public startSession(): void {
    this.sessionCounter += 1;
    this.sessionGeneration = `session-${this.sessionCounter}`;
    this.turnId = null;
    this.providerResponseId = null;
    this.playbackGeneration = null;
    this.operationId = null;
    this.greetingSentValue = false;
    this.providerResponseClosedValue = false;
    this.closedTurnIds.clear();
    this.turnOrder.clear();
    this.transition({ kind: "credential-acquiring" });
    this.emitSnapshot();
  }

  public markProvisioning(): void {
    this.transition({ kind: "provisioning" });
  }

  public markConnecting(): void {
    this.transition({ kind: "connecting" });
  }

  public markGreetingSent(): void {
    this.greetingSentValue = true;
    this.emitSnapshot();
  }

  public requestGreeting(): boolean {
    if (this.greetingSentValue || this.stateValue === "CLOSING" || this.stateValue === "CLOSED") {
      return false;
    }
    this.greetingSentValue = true;
    this.transition({ kind: "greeting-requested" });
    this.publish(
      "ORCHESTRATOR_GREETING_REQUESTED",
      "voice.provider",
      "provider-adapter",
      "high",
      { greetingSent: true },
    );
    this.emitSnapshot();
    return true;
  }

  public close(): void {
    this.transition({ kind: "closing" });
    this.publish("ORCHESTRATOR_CLOSE_REQUESTED", "voice.transport", "orchestrator", "high", {
      identity: this.identity,
    });
    this.transition({ kind: "closed" });
    this.emitSnapshot();
  }

  public fail(reason: string): void {
    this.transition({ kind: "failed" });
    this.publish("ORCHESTRATOR_FAILED", "voice.recovery", "orchestrator", "critical", {
      reason,
      identity: this.identity,
    });
    this.emitSnapshot();
  }

  public dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private handleProviderEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    const event = parseVoiceEvent(envelope.payload);
    if (!event) return;
    if (!this.acceptIdentity(event.type, event.identity)) return;

    if (this.nativeCuePending && event.type === "PROVIDER_TURN_COMPLETE") {
      this.nativeCuePending = false;
      this.publish("ORCHESTRATOR_GEMINI_CUE_COMPLETE", "voice.provider", "provider-adapter", "high", {
        identity: this.identity,
      });
      return;
    }
    const stamped = this.stampEvent(event);
    this.debug("identity stamped", stamped);
    this.applyProviderTransition(stamped);
    this.routeProviderEvent(stamped);
    this.emitSnapshot();
  }

  private handleBackchannelEnvelope(envelope: LayerLinkEnvelope<unknown>): void {
    if (envelope.messageType === "BACKCHANNEL_CUE_REQUESTED") {
      const request = parseCueRequest(envelope.payload);
      if (!request) return;
      if (!this.acceptIdentity("BACKCHANNEL_CUE_REQUESTED", envelope.identity)) return;
      const identity = this.stampIdentity(envelope.identity);
      if (request.delivery === "gemini-native") {
          this.nativeCuePending = true;
        this.publish("ORCHESTRATOR_GEMINI_CUE_REQUESTED", "voice.provider", "provider-adapter", "high", {
          cueText: request.cueText,
          cueIdentity: { ...request.cueIdentity, ...identity },
          delivery: request.delivery,
          identity,
        });
      } else if (request.cue) {
        this.publish("ORCHESTRATOR_BACKCHANNEL_CUE", "voice.playback", "playback", "high", {
          ...request,
          cueIdentity: { ...request.cueIdentity, ...identity },
          cue: { ...request.cue, identity },
          identity,
        });
      }
      return;
    }

    if (envelope.messageType === "backchannel.cue.approved") {
      this.publish("ORCHESTRATOR_BACKCHANNEL_APPROVED", "voice.orchestrator", "orchestrator", "telemetry", {
        result: envelope.payload,
        identity: this.stampIdentity(envelope.identity),
      });
    }
  }

  private handleOperationResult(envelope: LayerLinkEnvelope<unknown>): void {
    if (!isOperationResult(envelope.messageType)) return;
    const incomingOperationId = envelope.operation?.operationId ?? readOperationId(envelope.payload);
    if (!incomingOperationId || incomingOperationId !== this.operationId) {
      this.rejectStale("stale-operation-id", envelope.messageType, envelope.identity);
      return;
    }
    this.publish("ORCHESTRATOR_OPERATION_RESULT", "voice.provider", "provider-adapter", "high", {
      result: envelope.payload,
      operation: this.currentOperationIdentity(),
      identity: this.identity,
    });
    this.operationId = null;
    this.transition({ kind: "thinking" });
    this.emitSnapshot();
  }

  private acceptIdentity(eventType: string, incoming: GenerationIdentity): boolean {
    const reason = this.identityRejectionReason(eventType, incoming);
    if (reason) {
      this.rejectStale(reason, eventType, incoming);
      return false;
    }
    return true;
  }

  private identityRejectionReason(
    eventType: string,
    incoming: GenerationIdentity,
  ): OrchestratorDiagnostic["reason"] | null {
    if (
      incoming.sessionGeneration !== "unassigned" &&
      isOlderGeneration(incoming.sessionGeneration, this.sessionGeneration)
    ) {
      return "stale-session-generation";
    }
    if (
      incoming.playbackGeneration !== null &&
      this.playbackGeneration !== null &&
      incoming.playbackGeneration !== this.playbackGeneration &&
      eventType !== "PROVIDER_INPUT_TRANSCRIPT"
    ) {
      return "stale-playback-generation";
    }
    if (
      incoming.turnId !== null &&
      eventType !== "PROVIDER_INPUT_TRANSCRIPT" &&
      this.isStaleTurn(incoming.turnId)
    ) {
      return "stale-turn-id";
    }
    if (
      this.providerResponseClosedValue &&
      (eventType === "PROVIDER_AUDIO" ||
        eventType === "PROVIDER_OUTPUT_TRANSCRIPT" ||
        eventType === "PROVIDER_TOOL_CALL")
    ) {
      return "closed-response-boundary";
    }
    return null;
  }

  private stampEvent(event: VoiceEvent): VoiceEvent {
    const identity = this.stampIdentity(event.identity, event.type);
    return { ...event, identity } as VoiceEvent;
  }

  private stampIdentity(
    incoming: GenerationIdentity,
    eventType?: string,
  ): GenerationIdentity {
    if (incoming.turnId !== null && eventType === "PROVIDER_INPUT_TRANSCRIPT") {
      if (this.turnId !== incoming.turnId && this.closedTurnIds.has(incoming.turnId)) {
        return this.identity;
      }
      if (this.turnId !== incoming.turnId) {
        this.beginTurn(incoming.turnId);
      }
    } else if (this.turnId === null && incoming.turnId !== null) {
      this.beginTurn(incoming.turnId);
    }
    if (incoming.providerResponseId !== null) {
      this.providerResponseId = incoming.providerResponseId;
    }
    if (
      eventType !== "PROVIDER_INPUT_TRANSCRIPT" &&
      (eventType === "PROVIDER_AUDIO" || eventType === "PROVIDER_OUTPUT_TRANSCRIPT") &&
      this.playbackGeneration === null
    ) {
      this.playbackGeneration = this.nextPlaybackGeneration();
    }
    return this.identity;
  }

  private applyProviderTransition(event: VoiceEvent): void {
    switch (event.type) {
      case "PROVIDER_READY":
        this.transition({ kind: "provider-ready" });
        break;
      case "PROVIDER_INPUT_TRANSCRIPT":
        if (event.payload.isFinal === true) {
          this.transition({ kind: "input-final" });
        } else {
          const repeated = this.turnId !== null && event.identity.turnId === this.turnId;
          this.transition({ kind: "input-partial", repeated });
        }
        break;
      case "PROVIDER_OUTPUT_TRANSCRIPT":
      case "PROVIDER_AUDIO":
        this.transition({ kind: "output" });
        break;
      case "PROVIDER_INTERRUPTED":
        this.handleInterruption();
        break;
      case "PROVIDER_TURN_COMPLETE":
        this.handleTurnComplete();
        break;
      case "PROVIDER_TOOL_CALL":
        this.operationId = this.nextOperationId();
        this.transition({ kind: "tool-call" });
        break;
      case "PROVIDER_GOAWAY":
        this.transition({ kind: "recovering" });
        break;
      case "PROVIDER_ERROR":
        this.transition({ kind: "failed" });
        break;
      default:
        break;
    }
  }

  private routeProviderEvent(event: VoiceEvent): void {
    if (event.type === "PROVIDER_AUDIO") {
      this.publish("ORCHESTRATOR_AUDIO_EVENT", "voice.playback", "playback", "high", {
        event,
        identity: event.identity,
      });
      return;
    }
    if (event.type === "PROVIDER_TOOL_CALL") {
      const operation = this.currentOperationIdentity();
      this.publish("ORCHESTRATOR_OPERATION_REQUESTED", "voice.operation", "operation", "high", {
        event,
        operation,
        identity: event.identity,
      });
      return;
    }
    if (event.type === "PROVIDER_OUTPUT_TRANSCRIPT") {
      this.publish("ORCHESTRATOR_OUTPUT_TRANSCRIPT", "voice.transcript", "transcript", "normal", {
        event,
        identity: event.identity,
      });
      return;
    }
    this.publish("ORCHESTRATOR_TRANSCRIPT_EVENT", "voice.transcript", "transcript", "normal", {
      event,
      identity: event.identity,
    });
  }

  private handleInterruption(): void {
    const oldPlaybackGeneration = this.playbackGeneration;
    const nextPlaybackGeneration = this.nextPlaybackGeneration();
    this.providerResponseClosedValue = false;
    this.nativeCuePending = false;
    this.playbackGeneration = nextPlaybackGeneration;
    this.transition({ kind: "interrupted" });
    this.publish("ORCHESTRATOR_FLUSH_PLAYBACK", "voice.playback", "playback", "critical", {
      oldPlaybackGeneration,
      nextPlaybackGeneration,
      identity: this.identity,
    });
  }

  private handleTurnComplete(): void {
    if (this.turnId !== null) this.closedTurnIds.add(this.turnId);
    this.providerResponseClosedValue = true;
    this.nativeCuePending = false;
    this.playbackGeneration = null;
    this.operationId = null;
    this.transition({ kind: "turn-complete" });
  }

  private beginTurn(turnId: string): void {
    this.turnId = turnId;
    this.turnCounter += 1;
    this.turnOrder.set(turnId, this.turnCounter);
    this.providerResponseId = null;
    this.playbackGeneration = null;
    this.operationId = null;
    this.providerResponseClosedValue = false;
  }

  private isStaleTurn(incomingTurnId: string): boolean {
    if (this.closedTurnIds.has(incomingTurnId)) return true;
    if (this.turnId === null || incomingTurnId === this.turnId) return false;
    const incomingOrder = this.turnOrder.get(incomingTurnId);
    const currentOrder = this.turnOrder.get(this.turnId);
    if (incomingOrder !== undefined && currentOrder !== undefined) {
      return incomingOrder < currentOrder;
    }
    return isOlderGeneration(incomingTurnId, this.turnId);
  }

  private currentOperationIdentity(): OperationIdentity {
    if (!this.operationId) this.operationId = this.nextOperationId();
    return { ...this.identity, operationId: this.operationId };
  }

  private nextPlaybackGeneration(): string {
    this.playbackCounter += 1;
    return `${this.sessionGeneration}-playback-${this.playbackCounter}`;
  }

  private nextOperationId(): string {
    this.operationCounter += 1;
    return `${this.sessionGeneration}-operation-${this.operationCounter}`;
  }

  private transition(transition: OrchestratorTransition): void {
    const previous = this.stateValue;
    this.stateValue = transitionState(this.stateValue, transition);
    if (previous !== this.stateValue) {
      this.publish("ORCHESTRATOR_STATE_CHANGED", "voice.orchestrator", "orchestrator", "telemetry", {
        from: previous,
        to: this.stateValue,
        identity: this.identity,
      });
      this.debug("state transition", { from: previous, to: this.stateValue, identity: this.identity });
    }
  }

  private rejectStale(
    reason: OrchestratorDiagnostic["reason"],
    eventType: string,
    identity: GenerationIdentity,
  ): void {
    this.staleEventsRejectedValue += 1;
    const diagnostic: OrchestratorDiagnostic = {
      type: "ORCHESTRATOR_STALE_REJECTED",
      reason,
      eventType,
      identity,
    };
    this.publish("ORCHESTRATOR_STALE_REJECTED", "voice.orchestrator", "orchestrator", "telemetry", diagnostic);
    this.debug("stale event rejected", diagnostic);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.publish("orchestrator.snapshot.updated", "voice.orchestrator", "orchestrator", "telemetry", this.snapshot);
  }

  private publish(
    messageType: string,
    topic: string,
    targetLayer: "orchestrator" | "playback" | "transcript" | "operation" | "provider-adapter",
    priority: "critical" | "high" | "normal" | "telemetry",
    payload: unknown,
  ): void {
    this.bus.publish(
      createEventEnvelope({
        messageId: `${messageType}-${this.nowMono()}-${Math.random().toString(36).slice(2)}`,
        messageType,
        sourceLayer: "orchestrator",
        targetLayer,
        topic,
        priority,
        timestampMono: this.nowMono(),
        ttlMs: 2_000,
        identity: this.identity,
        correlationId: "voice-orchestrator",
        payload,
      }),
    );
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_ORCHESTRATOR && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), `[Orchestrator] ${message}`, details ?? "");
    }
  }
}

function parseVoiceEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<VoiceEvent>;
  return typeof candidate.type === "string" && candidate.type.startsWith("PROVIDER_")
    ? (candidate as VoiceEvent)
    : null;
}

function parseCueRequest(value: unknown): BackchannelCueRequestPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BackchannelCueRequestPayload>;
  return candidate.cueIdentity &&
    typeof candidate.cueText === "string" &&
    (candidate.delivery === "gemini-native" || (candidate.delivery === "prebuilt-audio" && candidate.cue)) &&
    candidate.reason === "natural-pause"
    ? (candidate as BackchannelCueRequestPayload)
    : null;
}

function isOperationResult(messageType: string): boolean {
  return messageType === "operation.result" || messageType === "OPERATION_RESULT" || messageType === "TOOL_RESULT";
}

function readOperationId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly operationId?: unknown; readonly operation?: { readonly operationId?: unknown } };
  if (typeof candidate.operationId === "string") return candidate.operationId;
  return typeof candidate.operation?.operationId === "string" ? candidate.operation.operationId : null;
}

function isOlderGeneration(incoming: string, current: string): boolean {
  const incomingNumber = readGenerationNumber(incoming);
  const currentNumber = readGenerationNumber(current);
  if (incomingNumber !== null && currentNumber !== null) return incomingNumber < currentNumber;
  return incoming !== current && incoming !== "unassigned";
}

function readGenerationNumber(value: string): number | null {
  const match = /(?:^|[-:])(?:session[-:]?)?(\d+)(?:$|[-:])/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}
