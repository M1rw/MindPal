import type { AudioChunk, GenerationIdentity } from "../core/layer-link";

export const REALTIME_TTS_ENDPOINT = "/api/voice/v3/tts";
export const REALTIME_TTS_SAMPLE_RATE = 24_000 as const;
export const REALTIME_TTS_FORMAT = "pcm16" as const;

export type TtsEmotion = "neutral" | "calm" | "empathetic" | "concerned" | "attentive" | "soft";

export type RealtimeTtsRequest = {
  readonly text: string;
  readonly persona: string;
  readonly emotion: TtsEmotion;
  readonly format: typeof REALTIME_TTS_FORMAT;
  readonly sampleRate: typeof REALTIME_TTS_SAMPLE_RATE;
};

export type RealtimeTtsResponse = {
  readonly audioBase64: string;
  readonly durationMs: number;
  readonly cached?: boolean;
  readonly voiceId?: string | null;
  readonly persona?: string;
  readonly fallback?: "non_verbal_hum" | "persona_mapping_missing";
};

export type TtsGenerationSource = "network" | "local" | "fallback";

export type TtsProviderState = "idle" | "network" | "local" | "fallback" | "ready" | "error";

export type GeneratedCue = {
  readonly chunk: AudioChunk;
  readonly source: TtsGenerationSource;
  readonly durationMs: number;
  readonly latencyMs: number;
};

export function createRealtimeTtsRequest(
  cueText: string,
  voicePersona: string,
  emotion: TtsEmotion,
): RealtimeTtsRequest {
  const text = cueText.trim();
  const persona = voicePersona.trim();
  if (!text) throw new RangeError("Realtime TTS cue text cannot be empty");
  if (!persona) throw new RangeError("Realtime TTS persona cannot be empty");
  if (!isTtsEmotion(emotion)) throw new RangeError("Unsupported realtime TTS emotion");
  return {
    text,
    persona,
    emotion,
    format: REALTIME_TTS_FORMAT,
    sampleRate: REALTIME_TTS_SAMPLE_RATE,
  };
}

export function isTtsEmotion(value: unknown): value is TtsEmotion {
  return value === "neutral" || value === "calm" || value === "empathetic" || value === "concerned" || value === "attentive" || value === "soft";
}

export function parseRealtimeTtsResponse(value: unknown): RealtimeTtsResponse {
  if (typeof value !== "object" || value === null) throw new Error("Realtime TTS response must be an object");
  const candidate = value as {
    readonly audioBase64?: unknown;
    readonly durationMs?: unknown;
    readonly cached?: unknown;
    readonly voiceId?: unknown;
    readonly persona?: unknown;
    readonly fallback?: unknown;
  };
  if (typeof candidate.audioBase64 !== "string") {
    throw new Error("Realtime TTS response is missing audioBase64");
  }
  const fallback = candidate.fallback === "non_verbal_hum" || candidate.fallback === "persona_mapping_missing" ? candidate.fallback : undefined;
  if (candidate.audioBase64.length === 0 && fallback === undefined) {
    throw new Error("Realtime TTS response is missing audioBase64");
  }
  if (typeof candidate.durationMs !== "number" || !Number.isFinite(candidate.durationMs) || candidate.durationMs <= 0 || candidate.durationMs > 2_000) {
    throw new Error("Realtime TTS response has an invalid durationMs");
  }
  return {
    audioBase64: candidate.audioBase64,
    durationMs: candidate.durationMs,
    ...(typeof candidate.cached === "boolean" ? { cached: candidate.cached } : {}),
    ...(typeof candidate.voiceId === "string" || candidate.voiceId === null ? { voiceId: candidate.voiceId } : {}),
    ...(typeof candidate.persona === "string" ? { persona: candidate.persona } : {}),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

export function makeTtsAudioChunk(
  response: RealtimeTtsResponse,
  identity: GenerationIdentity,
  chunkId: string,
): AudioChunk {
  const data = decodeBase64(response.audioBase64);
  if (data.byteLength === 0 || data.byteLength % 2 !== 0) throw new Error("Realtime TTS audio must be non-empty PCM16");
  return {
    chunkId,
    sequence: 0,
    format: "pcm_s16le",
    sampleRate: REALTIME_TTS_SAMPLE_RATE,
    channels: 1,
    data,
    audioLane: "backchannel",
    identity,
  };
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
