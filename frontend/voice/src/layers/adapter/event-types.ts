import type { GenerationIdentity } from "../../core/layer-link";

export const PROVIDER_EVENT_TYPES = [
  "PROVIDER_READY",
  "PROVIDER_INPUT_TRANSCRIPT",
  "PROVIDER_OUTPUT_TRANSCRIPT",
  "PROVIDER_AUDIO",
  "PROVIDER_TOOL_CALL",
  "PROVIDER_INTERRUPTED",
  "PROVIDER_TURN_COMPLETE",
  "PROVIDER_GENERATION_COMPLETE",
  "PROVIDER_RESUMPTION_UPDATED",
  "PROVIDER_GOAWAY",
  "PROVIDER_ERROR",
  "PROVIDER_INTERNAL_THOUGHT_FILTERED",
] as const;

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

export type ProviderEventBase<TType extends ProviderEventType, TPayload> = {
  readonly type: TType;
  readonly identity: GenerationIdentity;
  readonly payload: TPayload;
};

export type ProviderTranscriptPayload = {
  readonly text: string;
  readonly isFinal: boolean | null;
  readonly cumulative: boolean | null;
};

export type ProviderAudioPayload = {
  readonly dataBase64: string;
  readonly mimeType: string;
  readonly sampleRate: number;
};

export type ProviderToolCallPayload = {
  readonly call: unknown;
};

export type ProviderResumptionPayload = {
  readonly handle: string | null;
  readonly resumable: boolean | null;
};

export type ProviderGoAwayPayload = {
  readonly timeLeftMs: number | null;
};

export type ProviderErrorPayload = {
  readonly error: unknown;
};

export type ProviderThoughtFilteredPayload = {
  readonly reason: "part.thought" | "thought-mime-type" | "thought-metadata";
  readonly text: string | null;
};

export type VoiceEvent =
  | ProviderEventBase<"PROVIDER_READY", Record<string, never>>
  | ProviderEventBase<"PROVIDER_INPUT_TRANSCRIPT", ProviderTranscriptPayload>
  | ProviderEventBase<"PROVIDER_OUTPUT_TRANSCRIPT", ProviderTranscriptPayload>
  | ProviderEventBase<"PROVIDER_AUDIO", ProviderAudioPayload>
  | ProviderEventBase<"PROVIDER_TOOL_CALL", ProviderToolCallPayload>
  | ProviderEventBase<"PROVIDER_INTERRUPTED", Record<string, never>>
  | ProviderEventBase<"PROVIDER_TURN_COMPLETE", Record<string, never>>
  | ProviderEventBase<"PROVIDER_GENERATION_COMPLETE", Record<string, never>>
  | ProviderEventBase<"PROVIDER_RESUMPTION_UPDATED", ProviderResumptionPayload>
  | ProviderEventBase<"PROVIDER_GOAWAY", ProviderGoAwayPayload>
  | ProviderEventBase<"PROVIDER_ERROR", ProviderErrorPayload>
  | ProviderEventBase<
      "PROVIDER_INTERNAL_THOUGHT_FILTERED",
      ProviderThoughtFilteredPayload
    >;
