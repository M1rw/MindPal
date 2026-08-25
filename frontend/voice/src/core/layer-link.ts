/**
 * Core cross-layer contracts for MindPal Voice V3.
 *
 * These types are shared by the browser main thread, AudioWorklet boundary,
 * provider adapter, orchestrator, and debug UI. They intentionally contain no
 * DOM or framework dependencies so the realtime engine remains portable.
 */

export const LAYER_LINK_SCHEMA_VERSION = 1 as const;

export type LayerName =
  | "capture"
  | "security"
  | "transport"
  | "provider-adapter"
  | "model-router"
  | "orchestrator"
  | "transcript"
  | "playback"
  | "caption"
  | "backchannel"
  | "prosody"
  | "affect"
  | "memory"
  | "operation"
  | "recovery"
  | "persistence"
  | "telemetry";

export type Priority = "critical" | "high" | "normal" | "low" | "telemetry";

export type MessageClass =
  | "command"
  | "event"
  | "streamControl"
  | "ack"
  | "nack"
  | "heartbeat"
  | "telemetry"
  | "deadLetter";

export type AudioLane = "main" | "backchannel" | "system";

export type GenerationIdentity = {
  readonly sessionGeneration: string;
  readonly turnId: string | null;
  readonly providerResponseId: string | null;
  readonly playbackGeneration: string | null;
};

export type TurnIdentity = GenerationIdentity & {
  readonly turnId: string;
};

export type OperationIdentity = GenerationIdentity & {
  readonly operationId: string;
};

export type BackchannelCueIdentity = GenerationIdentity & {
  readonly cueId: string;
  readonly cueSource: "native" | "local-rules" | "small-model" | "local-audio" | "realtime-tts";
  readonly cueLane: "backchannel";
  readonly createdAtMono: number;
  readonly expiresAtMono: number;
};

export type LayerLinkEnvelope<TPayload> = {
  readonly schemaVersion: typeof LAYER_LINK_SCHEMA_VERSION;
  readonly messageId: string;
  readonly messageClass: MessageClass;
  readonly messageType: string;
  readonly sourceLayer: LayerName;
  readonly targetLayer?: LayerName;
  readonly topic?: string;
  readonly priority: Priority;
  readonly timestampMono: number;
  readonly timestampWall: string;
  readonly ttlMs: number;
  readonly identity: GenerationIdentity;
  readonly operation?: OperationIdentity;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly payload: TPayload;
};

export type Command<TPayload> = LayerLinkEnvelope<TPayload> & {
  readonly messageClass: "command";
};

export type Event<TPayload> = LayerLinkEnvelope<TPayload> & {
  readonly messageClass: "event";
};

export type StreamControl<TPayload> = LayerLinkEnvelope<TPayload> & {
  readonly messageClass: "streamControl";
};

export type Ack = LayerLinkEnvelope<{
  readonly accepted: true;
  readonly acceptedMessageId: string;
}> & {
  readonly messageClass: "ack";
};

export type Nack = LayerLinkEnvelope<{
  readonly accepted: false;
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}> & {
  readonly messageClass: "nack";
};

export type DeadLetter = LayerLinkEnvelope<{
  readonly originalMessageId: string;
  readonly originalType: string;
  readonly reason: string;
}> & {
  readonly messageClass: "deadLetter";
};

/**
 * A 20 ms mono PCM16 capture frame. The ArrayBuffer is transferable and should
 * be moved across the AudioWorklet boundary rather than copied. The capture
 * processor must not access the DOM or any main-thread-only APIs.
 */
export type AudioFrame = {
  readonly frameId: string;
  readonly sequence: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly format: "pcm_s16le";
  readonly data: ArrayBuffer;
  readonly capturedAtMono: number;
  readonly durationMs: 20;
  readonly muted: boolean;
  readonly rms: number;
};

/** Provider output audio is 24 kHz mono PCM16. */
export type AudioChunk = {
  readonly chunkId: string;
  readonly sequence: number;
  readonly format: "pcm_s16le";
  readonly sampleRate: 24000;
  readonly channels: 1;
  readonly data: ArrayBuffer;
  /** Same-thread decoded buffer for preloaded local cues; opaque to core contracts. */
  readonly decodedAudioBuffer?: unknown;
  readonly audioLane: AudioLane;
  readonly identity: GenerationIdentity;
};

export type QueueSnapshot = {
  readonly name: string;
  readonly depth: number;
  readonly capacity: number;
  readonly highWatermark: number;
  readonly lowWatermark: number;
};

export type VoiceRuntimeSnapshot = {
  readonly state: string;
  readonly identity: GenerationIdentity;
  readonly queueSnapshots: readonly QueueSnapshot[];
  readonly staleEventsRejected: number;
  readonly telemetryDropped: number;
  readonly updatedAtMono: number;
};

export function isMessageClass(value: unknown): value is MessageClass {
  return (
    value === "command" ||
    value === "event" ||
    value === "streamControl" ||
    value === "ack" ||
    value === "nack" ||
    value === "heartbeat" ||
    value === "telemetry" ||
    value === "deadLetter"
  );
}

export function isLayerName(value: unknown): value is LayerName {
  return (
    value === "capture" ||
    value === "security" ||
    value === "transport" ||
    value === "provider-adapter" ||
    value === "model-router" ||
    value === "orchestrator" ||
    value === "transcript" ||
    value === "playback" ||
    value === "caption" ||
    value === "backchannel" ||
        value === "prosody" ||
    value === "affect" ||
    value === "memory" ||
    value === "operation" ||
    value === "recovery" ||
    value === "persistence" ||
    value === "telemetry"
  );
}
