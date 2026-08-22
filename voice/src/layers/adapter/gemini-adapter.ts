import type { GenerationIdentity } from "../../core/layer-link";
import { DEBUG_V3 } from "../../debug/debug-flags";
import type {
  ProviderAudioPayload,
  ProviderTranscriptPayload,
  VoiceEvent,
} from "./event-types";

export const DEBUG_ADAPTER = DEBUG_V3;

const EMPTY_IDENTITY: GenerationIdentity = {
  sessionGeneration: "unassigned",
  turnId: null,
  providerResponseId: null,
  playbackGeneration: null,
};

/**
 * Stateless Gemini Live normalizer. It owns no turn/session state and never
 * mutates the raw provider payload. Each call returns all normalized events
 * represented by the message, including every multipart model-turn part.
 */
export class GeminiProviderAdapter {
  public normalize(raw: unknown): VoiceEvent[] {
    const parsed = parseProviderPayload(raw);
    if (parsed.error) {
      const events: VoiceEvent[] = [
        {
          type: "PROVIDER_ERROR",
          identity: EMPTY_IDENTITY,
          payload: { error: parsed.error },
        },
      ];
      this.debug(raw, events);
      return events;
    }

    const message = parsed.message;
    const identity = extractIdentity(message);
    const events: VoiceEvent[] = [];

    if (isSetupComplete(message)) {
      events.push({ type: "PROVIDER_READY", identity, payload: {} });
    }

    const resumption = readResumptionUpdate(message);
    if (resumption) {
      events.push({
        type: "PROVIDER_RESUMPTION_UPDATED",
        identity,
        payload: resumption,
      });
    }

    const goAway = readGoAway(message);
    if (goAway) {
      events.push({ type: "PROVIDER_GOAWAY", identity, payload: goAway });
    }

    if (message.error !== undefined) {
      events.push({
        type: "PROVIDER_ERROR",
        identity,
        payload: { error: message.error },
      });
    }

    const rootToolCall = message.toolCall ?? message.tool_call;
    if (rootToolCall !== undefined) {
      events.push({
        type: "PROVIDER_TOOL_CALL",
        identity,
        payload: { call: rootToolCall },
      });
    }

    const serverContent = readRecord(message.serverContent ?? message.server_content);
    if (serverContent) {
      this.normalizeServerContent(serverContent, identity, events);
    }

    this.debug(raw, events);
    return events;
  }

  private normalizeServerContent(
    content: Record<string, unknown>,
    identity: GenerationIdentity,
    events: VoiceEvent[],
  ): void {
    if (content.interrupted === true) {
      events.push({ type: "PROVIDER_INTERRUPTED", identity, payload: {} });
    }

    const inputTranscript = readTranscriptAlias(content, "input");
    if (inputTranscript) {
      events.push({
        type: "PROVIDER_INPUT_TRANSCRIPT",
        identity,
        payload: inputTranscript,
      });
    }

    const outputTranscript = readTranscriptAlias(content, "output");
    if (outputTranscript) {
      events.push({
        type: "PROVIDER_OUTPUT_TRANSCRIPT",
        identity,
        payload: outputTranscript,
      });
    }

    const toolCall = content.toolCall ?? content.tool_call;
    if (toolCall !== undefined) {
      events.push({
        type: "PROVIDER_TOOL_CALL",
        identity,
        payload: { call: toolCall },
      });
    }

    const modelTurn = readRecord(content.modelTurn ?? content.model_turn);
    const parts = readArray(modelTurn?.parts);
    for (const partValue of parts) {
      const part = readRecord(partValue);
      if (!part) continue;
      this.normalizePart(part, identity, events);
    }

    if (content.turnComplete === true || content.turn_complete === true) {
      events.push({ type: "PROVIDER_TURN_COMPLETE", identity, payload: {} });
    }
  }

  private normalizePart(
    part: Record<string, unknown>,
    identity: GenerationIdentity,
    events: VoiceEvent[],
  ): void {
    const thought = readThoughtMetadata(part);
    const text = typeof part.text === "string" ? part.text : null;
    if (thought) {
      events.push({
        type: "PROVIDER_INTERNAL_THOUGHT_FILTERED",
        identity,
        payload: {
          reason: thought.reason,
          text,
        },
      });
      return;
    }

    const inputTranscript = readTranscriptAlias(part, "input");
    if (inputTranscript) {
      events.push({ type: "PROVIDER_INPUT_TRANSCRIPT", identity, payload: inputTranscript });
    }

    const outputTranscript = readTranscriptAlias(part, "output");
    if (outputTranscript) {
      events.push({ type: "PROVIDER_OUTPUT_TRANSCRIPT", identity, payload: outputTranscript });
    }

    if (text !== null) {
      events.push({
        type: "PROVIDER_OUTPUT_TRANSCRIPT",
        identity,
        payload: {
          text,
          isFinal: readBoolean(part, "isFinal", "is_final"),
          cumulative: readBoolean(part, "cumulative"),
        },
      });
    }

    const audio = readAudioPayload(part);
    if (audio) {
      events.push({ type: "PROVIDER_AUDIO", identity, payload: audio });
    }

    const toolCall = part.toolCall ?? part.tool_call;
    if (toolCall !== undefined) {
      events.push({ type: "PROVIDER_TOOL_CALL", identity, payload: { call: toolCall } });
    }
  }

  private debug(raw: unknown, events: readonly VoiceEvent[]): void {
    if (DEBUG_ADAPTER && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), "[Adapter] raw", raw);
      console.debug(new Date().toISOString(), "[Adapter] normalized", events);
    }
  }
}

export function normalizeGeminiMessage(raw: unknown): VoiceEvent[] {
  return new GeminiProviderAdapter().normalize(raw);
}

function parseProviderPayload(raw: unknown):
  | { readonly message: Record<string, unknown>; readonly error?: never }
  | { readonly message?: never; readonly error: Error } {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const message = readRecord(parsed);
      return message
        ? { message }
        : { error: new Error("Gemini message must be a JSON object") };
    } catch (error) {
      return { error: toError(error, "invalid Gemini JSON message") };
    }
  }

  if (isArrayBufferPayload(raw)) {
    try {
      const bytes = raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw as ArrayBuffer);
      const text = new TextDecoder().decode(bytes);
      return parseProviderPayload(text);
    } catch (error) {
      return { error: toError(error, "invalid Gemini binary message") };
    }
  }

  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView & { readonly buffer: ArrayBuffer };
    return parseProviderPayload(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  const message = readRecord(raw);
  return message ? { message } : { error: new Error("unsupported Gemini message type") };
}

function extractIdentity(message: Record<string, unknown>): GenerationIdentity {
  const serverContent = readRecord(message.serverContent ?? message.server_content);
  const source = serverContent ?? message;
  return {
    ...EMPTY_IDENTITY,
    turnId: readNullableString(source, "turnId", "turn_id"),
    providerResponseId: readNullableString(
      source,
      "providerResponseId",
      "provider_response_id",
      "responseId",
      "response_id",
    ),
  };
}

function isSetupComplete(message: Record<string, unknown>): boolean {
  // Google defines BidiGenerateContentSetupComplete as an empty message
  // object. Keep boolean compatibility for older fixtures and mocks,
  // and handle null value transcoding.
  if (Object.prototype.hasOwnProperty.call(message, "setupComplete")) return true;
  if (Object.prototype.hasOwnProperty.call(message, "setup_complete")) return true;
  return false;
}

function readResumptionUpdate(
  message: Record<string, unknown>,
): { handle: string | null; resumable: boolean | null } | null {
  const value = message.sessionResumptionUpdate ?? message.session_resumption_update;
  const update = readRecord(value);
  if (!update) return null;
  return {
    handle: readNullableString(update, "newHandle", "new_handle", "handle"),
    resumable: readBoolean(update, "resumable"),
  };
}

function readGoAway(
  message: Record<string, unknown>,
): { timeLeftMs: number | null } | null {
  const value = message.goAway ?? message.go_away;
  const goAway = readRecord(value);
  if (!goAway) return null;
  const timeLeft = goAway.timeLeftMs ?? goAway.time_left_ms ?? goAway.timeLeft ?? goAway.time_left;
  return {
    timeLeftMs: typeof timeLeft === "number" && Number.isFinite(timeLeft) ? timeLeft : null,
  };
}

function readTranscriptAlias(
  source: Record<string, unknown>,
  direction: "input" | "output",
): ProviderTranscriptPayload | null {
  const aliases =
    direction === "input"
      ? ["input_audio_transcription", "inputAudioTranscription", "input_transcription", "inputTranscription"]
      : ["output_audio_transcription", "outputAudioTranscription", "output_transcription", "outputTranscription"];
  for (const alias of aliases) {
    const value = source[alias];
    if (typeof value === "string") {
      return { text: value, isFinal: null, cumulative: null };
    }
    const record = readRecord(value);
    if (record) {
      const text = record.text ?? record.transcript;
      if (typeof text === "string") {
        return {
          text,
          isFinal: readBoolean(record, "isFinal", "is_final", "final"),
          cumulative: readBoolean(record, "cumulative"),
        };
      }
    }
  }
  return null;
}

function readAudioPayload(part: Record<string, unknown>): ProviderAudioPayload | null {
  const inline = readRecord(part.inlineData ?? part.inline_data);
  const audio = readRecord(part.audio);
  const source = inline ?? audio;
  const directData = source?.data ?? part.data;
  if (typeof directData !== "string") return null;
  const mimeType =
    typeof source?.mimeType === "string"
      ? source.mimeType
      : typeof source?.mime_type === "string"
        ? source.mime_type
        : "audio/pcm;rate=24000";
  return {
    dataBase64: directData,
    mimeType,
    sampleRate: readSampleRate(mimeType),
  };
}

function readSampleRate(mimeType: string): number {
  const match = /(?:^|;)\s*rate\s*=\s*(\d+)/i.exec(mimeType);
  const value = match?.[1] ? Number(match[1]) : 24_000;
  return Number.isFinite(value) && value > 0 ? value : 24_000;
}

function readThoughtMetadata(
  part: Record<string, unknown>,
): { reason: "part.thought" | "thought-mime-type" | "thought-metadata" } | null {
  if (part.thought === true) return { reason: "part.thought" };
  const mime = String(part.mimeType ?? part.mime_type ?? "").toLowerCase();
  if (mime.includes("thought") || mime.includes("thinking")) {
    return { reason: "thought-mime-type" };
  }
  const metadata = readRecord(part.metadata);
  if (metadata?.thought === true || metadata?.isThought === true) {
    return { reason: "thought-metadata" };
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key];
  }
  return null;
}

function readNullableString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key].length > 0) return source[key];
  }
  return null;
}

function isArrayBufferPayload(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

