import {
  LAYER_LINK_SCHEMA_VERSION,
  type Event,
  type LayerLinkEnvelope,
  type LayerName,
  type MessageClass,
  type Priority,
  type QueueSnapshot,
} from "./layer-link";

export type MessageHandler<TPayload> = (
  envelope: LayerLinkEnvelope<TPayload>,
) => void;

export type MessageBusOptions = {
  readonly nowMono?: () => number;
  readonly maxDeliveredEvents?: number;
  readonly onDiagnostic?: (diagnostic: BusDiagnostic) => void;
};

export type BusDiagnostic = {
  readonly type:
    | "message-rejected"
    | "message-expired"
    | "handler-failed"
    | "subscription-failed";
  readonly messageId?: string;
  readonly messageType?: string;
  readonly reason: string;
  readonly error?: unknown;
};

export type PublishResult =
  | { readonly accepted: true; readonly delivered: number }
  | { readonly accepted: false; readonly reason: "invalid" | "expired" };

type Subscription = {
  readonly id: number;
  readonly topic?: string;
  readonly messageType?: string;
  readonly handler: MessageHandler<unknown>;
};

const VALID_PRIORITIES: readonly Priority[] = [
  "critical",
  "high",
  "normal",
  "low",
  "telemetry",
];

/**
 * Typed in-process LayerLink bus for the browser main thread.
 *
 * The bus is deliberately synchronous in Sprint 0. Later realtime layers may
 * add MessageChannel or worker ports, but all messages still pass through this
 * validation/TTL boundary before delivery. A handler exception is isolated and
 * reported through diagnostics instead of corrupting other subscribers.
 */
export class LayerLinkMessageBus {
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly nowMono: () => number;
  private readonly maxDeliveredEvents: number;
  private readonly onDiagnostic: ((diagnostic: BusDiagnostic) => void) | undefined;
  private nextSubscriptionId = 1;
  private deliveredEvents = 0;
  private rejectedEvents = 0;
  private expiredEvents = 0;
  private handlerFailures = 0;

  public constructor(options: MessageBusOptions = {}) {
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.maxDeliveredEvents = options.maxDeliveredEvents ?? 10_000;
    this.onDiagnostic = options.onDiagnostic;
  }

  public subscribe<TPayload>(
    handler: MessageHandler<TPayload>,
    filter: { readonly topic?: string; readonly messageType?: string } = {},
  ): () => void {
    const id = this.nextSubscriptionId++;
    const subscription: Subscription = {
      id,
      ...(filter.topic === undefined ? {} : { topic: filter.topic }),
      ...(filter.messageType === undefined
        ? {}
        : { messageType: filter.messageType }),
      handler: handler as MessageHandler<unknown>,
    };
    this.subscriptions.set(id, subscription);
    return () => {
      this.subscriptions.delete(id);
    };
  }

  public publish<TPayload>(envelope: LayerLinkEnvelope<TPayload>): PublishResult {
    const validation = validateEnvelope(envelope, this.nowMono());
    if (!validation.valid) {
      this.rejectedEvents += 1;
      if (validation.reason === "expired") this.expiredEvents += 1;
      const messageId = readStringField(envelope, "messageId");
      const messageType = readStringField(envelope, "messageType");
      this.emitDiagnostic({
        type: validation.reason === "expired" ? "message-expired" : "message-rejected",
        ...(messageId ? { messageId } : {}),
        ...(messageType ? { messageType } : {}),
        reason: validation.detail,
      });
      return {
        accepted: false,
        reason: validation.reason,
      };
    }

    if (this.deliveredEvents >= this.maxDeliveredEvents) {
      this.emitDiagnostic({
        type: "message-rejected",
        messageId: envelope.messageId,
        messageType: envelope.messageType,
        reason: "delivery safety limit reached",
      });
      return { accepted: false, reason: "invalid" };
    }

    let delivered = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.topic !== undefined && subscription.topic !== envelope.topic) {
        continue;
      }
      if (
        subscription.messageType !== undefined &&
        subscription.messageType !== envelope.messageType
      ) {
        continue;
      }

      try {
        subscription.handler(envelope);
        delivered += 1;
        this.deliveredEvents += 1;
      } catch (error) {
        this.handlerFailures += 1;
        this.emitDiagnostic({
          type: "handler-failed",
          messageId: envelope.messageId,
          messageType: envelope.messageType,
          reason: `subscriber ${subscription.id} threw`,
          error,
        });
      }
    }

    return { accepted: true, delivered };
  }

  public snapshot(): BusSnapshot {
    return {
      subscriptionCount: this.subscriptions.size,
      deliveredEvents: this.deliveredEvents,
      rejectedEvents: this.rejectedEvents,
      expiredEvents: this.expiredEvents,
      handlerFailures: this.handlerFailures,
    };
  }

  public queueSnapshots(): readonly QueueSnapshot[] {
    return [];
  }

  private emitDiagnostic(diagnostic: BusDiagnostic): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic(diagnostic);
    } catch (error) {
      this.emitDiagnosticSafely({
        type: "subscription-failed",
        reason: "diagnostic handler threw",
        error,
      });
    }
  }

  private emitDiagnosticSafely(diagnostic: BusDiagnostic): void {
    // Do not recurse through a user-provided diagnostic callback after it fails.
    if (import.meta.env?.DEV) {
      console.debug("[LayerLink] diagnostic handler failure", diagnostic);
    }
  }
}

export type BusSnapshot = {
  readonly subscriptionCount: number;
  readonly deliveredEvents: number;
  readonly rejectedEvents: number;
  readonly expiredEvents: number;
  readonly handlerFailures: number;
};

export type ValidatedEvent<TPayload> = Event<TPayload>;

export function createEventEnvelope<TPayload>({
  messageId,
  messageType,
  sourceLayer,
  targetLayer,
  topic,
  priority,
  timestampMono,
  timestampWall,
  ttlMs,
  identity,
  operation,
  causationId,
  correlationId,
  payload,
}: {
  readonly messageId: string;
  readonly messageType: string;
  readonly sourceLayer: LayerName;
  readonly targetLayer?: LayerName;
  readonly topic?: string;
  readonly priority: Priority;
  readonly timestampMono: number;
  readonly timestampWall?: string;
  readonly ttlMs: number;
  readonly identity: LayerLinkEnvelope<unknown>["identity"];
  readonly operation?: LayerLinkEnvelope<unknown>["operation"];
  readonly causationId?: string;
  readonly correlationId: string;
  readonly payload: TPayload;
}): Event<TPayload> {
  return {
    schemaVersion: LAYER_LINK_SCHEMA_VERSION,
    messageId,
    messageClass: "event",
    messageType,
    sourceLayer,
    ...(targetLayer === undefined ? {} : { targetLayer }),
    ...(topic === undefined ? {} : { topic }),
    priority,
    timestampMono,
    timestampWall: timestampWall ?? new Date().toISOString(),
    ttlMs,
    identity,
    ...(operation === undefined ? {} : { operation }),
    ...(causationId === undefined ? {} : { causationId }),
    correlationId,
    payload,
  };
}

type ValidationSuccess = { readonly valid: true };
type ValidationFailure = {
  readonly valid: false;
  readonly reason: "invalid" | "expired";
  readonly detail: string;
};

type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateEnvelope(
  envelope: unknown,
  nowMono: number,
): ValidationResult {
  if (!isRecord(envelope)) {
    return invalid("envelope must be an object");
  }
  if (envelope.schemaVersion !== LAYER_LINK_SCHEMA_VERSION) {
    return invalid("unsupported schemaVersion");
  }
  if (!isNonEmptyString(envelope.messageId)) return invalid("messageId is required");
  if (!isMessageClassValue(envelope.messageClass)) {
    return invalid("messageClass is invalid");
  }
  if (!isNonEmptyString(envelope.messageType)) return invalid("messageType is required");
  if (!isLayerNameValue(envelope.sourceLayer)) return invalid("sourceLayer is invalid");
  if (!isPriority(envelope.priority)) return invalid("priority is invalid");
  if (!isFiniteNumber(envelope.timestampMono)) {
    return invalid("timestampMono must be finite");
  }
  if (!isNonEmptyString(envelope.timestampWall)) {
    return invalid("timestampWall is required");
  }
  if (!isFiniteNumber(envelope.ttlMs) || envelope.ttlMs <= 0) {
    return invalid("ttlMs must be greater than zero");
  }
  if (!isGenerationIdentity(envelope.identity)) {
    return invalid("identity is invalid");
  }
  if (!isNonEmptyString(envelope.correlationId)) {
    return invalid("correlationId is required");
  }
  if (envelope.targetLayer !== undefined && !isLayerNameValue(envelope.targetLayer)) {
    return invalid("targetLayer is invalid");
  }
  if (envelope.topic !== undefined && !isNonEmptyString(envelope.topic)) {
    return invalid("topic must be a non-empty string when present");
  }
  if (envelope.operation !== undefined && !isOperationIdentity(envelope.operation)) {
    return invalid("operation identity is invalid");
  }

  if (nowMono - envelope.timestampMono >= envelope.ttlMs) {
    return {
      valid: false,
      reason: "expired",
      detail: "message TTL has expired",
    };
  }

  return { valid: true };
}

function invalid(detail: string): ValidationFailure {
  return { valid: false, reason: "invalid", detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMessageClassValue(value: unknown): value is MessageClass {
  return typeof value === "string" && VALID_MESSAGE_CLASSES.includes(value as MessageClass);
}

function isLayerNameValue(value: unknown): value is LayerName {
  return typeof value === "string" && VALID_LAYER_NAMES.includes(value as LayerName);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && VALID_PRIORITIES.includes(value as Priority);
}

function isGenerationIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.sessionGeneration) &&
    (value.turnId === null || isNonEmptyString(value.turnId)) &&
    (value.providerResponseId === null || isNonEmptyString(value.providerResponseId)) &&
    (value.playbackGeneration === null || isNonEmptyString(value.playbackGeneration))
  );
}

function isOperationIdentity(value: unknown): boolean {
  return isGenerationIdentity(value) && isRecord(value) && isNonEmptyString(value.operationId);
}

function readStringField(
  value: unknown,
  field: "messageId" | "messageType",
): string | undefined {
  if (!isRecord(value) || typeof value[field] !== "string") return undefined;
  return value[field];
}

const VALID_MESSAGE_CLASSES: readonly MessageClass[] = [
  "command",
  "event",
  "streamControl",
  "ack",
  "nack",
  "heartbeat",
  "telemetry",
  "deadLetter",
];

const VALID_LAYER_NAMES: readonly LayerName[] = [
  "capture",
  "security",
  "transport",
  "provider-adapter",
  "model-router",
  "orchestrator",
  "transcript",
  "playback",
  "caption",
  "backchannel",
  "prosody",
  "affect",
  "face",
  "memory",
  "operation",
  "recovery",
  "persistence",
  "telemetry",
];
