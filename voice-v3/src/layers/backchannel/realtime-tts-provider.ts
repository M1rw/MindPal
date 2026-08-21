import type { AudioChunk, GenerationIdentity } from "../../core/layer-link";
import { DEBUG_V3 } from "../../debug/debug-flags";
import {
  REALTIME_TTS_ENDPOINT,
  type GeneratedCue,
  type RealtimeTtsRequest,
  type RealtimeTtsResponse,
  type TtsEmotion,
  type TtsGenerationSource,
  type TtsProviderState,
  createRealtimeTtsRequest,
  makeTtsAudioChunk,
  parseRealtimeTtsResponse,
} from "../../integration/tts-endpoint-contract";
import type { CueProvider } from "./cue-provider";

export const DEBUG_TTS = DEBUG_V3;
export const DEFAULT_TTS_NETWORK_TIMEOUT_MS = 180;
export const MAX_TTS_CACHE_ENTRIES = 32;

export type TtsProviderEvent =
  | { readonly type: "tts.request.started"; readonly persona: string; readonly emotion: TtsEmotion }
  | { readonly type: "tts.request.success"; readonly source: TtsGenerationSource; readonly cached: boolean; readonly durationMs: number }
  | { readonly type: "tts.request.timeout" }
  | { readonly type: "tts.request.failed"; readonly code: string }
  | { readonly type: "tts.cache.hit"; readonly persona: string; readonly emotion: TtsEmotion }
  | { readonly type: "tts.cache.miss"; readonly persona: string; readonly emotion: TtsEmotion }
  | { readonly type: "tts.persona_mapping_missing"; readonly persona: string }
  | { readonly type: "tts.emotion_unsupported"; readonly emotion: TtsEmotion }
  | { readonly type: "tts.fallback.nonverbal"; readonly reason: string }
  | { readonly type: "tts.duration_ms"; readonly value: number };

export type LocalTtsModel = {
  readonly initialize?: () => Promise<void>;
  readonly generate: (request: RealtimeTtsRequest) => Promise<RealtimeTtsResponse>;
};

export type RealtimeTTSProviderOptions = {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly getAuthToken?: () => Promise<string | null>;
  readonly getAppCheckToken?: () => Promise<string | null>;
  readonly localModel?: LocalTtsModel;
  readonly networkTimeoutMs?: number;
  readonly nowMs?: () => number;
  readonly onStateChange?: (state: TtsProviderState, source?: TtsGenerationSource) => void;
  readonly onEvent?: (event: TtsProviderEvent) => void;
};

export type RealtimeTtsGenerateOptions = {
  readonly cueText: string;
  readonly voicePersona: string;
  readonly emotion: TtsEmotion;
  readonly identity: GenerationIdentity;
  readonly cueId: string;
};

export type RealtimeTtsProviderSnapshot = {
  readonly state: TtsProviderState;
  readonly source: TtsGenerationSource | null;
  readonly cacheEntries: number;
  readonly lastLatencyMs: number;
  readonly lastError: string | null;
};

/**
 * Persona-matched verbal cue generator. The network endpoint is primary, an
 * injected preloaded local model is secondary, and a gender-neutral hum is the
 * final non-verbal fallback.
 */
export class RealtimeTTSProvider implements CueProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken: () => Promise<string | null>;
  private readonly getAppCheckToken: () => Promise<string | null>;
  private readonly localModel: LocalTtsModel | null;
  private readonly networkTimeoutMs: number;
  private readonly nowMs: () => number;
  private readonly onStateChange: ((state: TtsProviderState, source?: TtsGenerationSource) => void) | undefined;
  private readonly onEvent: ((event: TtsProviderEvent) => void) | undefined;
  private readonly cache = new Map<string, RealtimeTtsResponse>();
  private localReady = false;
  private localInitialization: Promise<void> | null = null;
  private stateValue: TtsProviderState = "idle";
  private sourceValue: TtsGenerationSource | null = null;
  private lastLatencyMsValue = 0;
  private lastErrorValue: string | null = null;

  public constructor(options: RealtimeTTSProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getAuthToken = options.getAuthToken ?? (async () => null);
    this.getAppCheckToken = options.getAppCheckToken ?? (async () => null);
    this.localModel = options.localModel ?? null;
    this.networkTimeoutMs = Math.max(50, options.networkTimeoutMs ?? DEFAULT_TTS_NETWORK_TIMEOUT_MS);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
  }

  public get snapshot(): RealtimeTtsProviderSnapshot {
    return {
      state: this.stateValue,
      source: this.sourceValue,
      cacheEntries: this.cache.size,
      lastLatencyMs: this.lastLatencyMsValue,
      lastError: this.lastErrorValue,
    };
  }

  public async initialize(): Promise<void> {
    if (!this.localModel || this.localReady) return;
    if (!this.localInitialization) {
      this.localInitialization = (async () => {
        await this.localModel?.initialize?.();
        this.localReady = true;
      })().catch((error: unknown) => {
        this.localReady = false;
        this.debug("local model initialization failed", error);
      });
    }
    await this.localInitialization;
  }

  public async generate(options: RealtimeTtsGenerateOptions): Promise<GeneratedCue> {
    const request = createRealtimeTtsRequest(options.cueText, options.voicePersona, options.emotion);
    const key = cacheKey(request);
    const startedAt = this.nowMs();
    this.emit({ type: "tts.request.started", persona: request.persona, emotion: request.emotion });
    const cached = this.cache.get(key);
    if (cached) {
      this.emit({ type: "tts.cache.hit", persona: request.persona, emotion: request.emotion });
      this.setState("ready", "network", this.nowMs() - startedAt);
      this.emit({ type: "tts.request.success", source: "network", cached: true, durationMs: cached.durationMs });
      this.emit({ type: "tts.duration_ms", value: cached.durationMs });
      this.debug("cache hit", { persona: request.persona });
      return {
        chunk: makeTtsAudioChunk(cached, options.identity, options.cueId),
        source: "network",
        durationMs: cached.durationMs,
        latencyMs: 0,
      };
    }

    this.emit({ type: "tts.cache.miss", persona: request.persona, emotion: request.emotion });
    this.setState("network");
    this.debug("network generation requested", { persona: request.persona, emotion: request.emotion });
    try {
      const networkResponse = await this.generateNetworkWithEmotionRetry(request);
      if (networkResponse.fallback !== undefined || networkResponse.audioBase64.length === 0) {
        this.emit({ type: "tts.persona_mapping_missing", persona: request.persona });
        return this.nonVerbalFallback(options, startedAt, "persona_mapping_missing");
      }
      const chunk = makeTtsAudioChunk(networkResponse, options.identity, options.cueId);
      this.store(key, networkResponse);
      const latencyMs = Math.max(0, this.nowMs() - startedAt);
      this.setState("ready", "network", latencyMs);
      this.emit({ type: "tts.request.success", source: "network", cached: Boolean(networkResponse.cached), durationMs: networkResponse.durationMs });
      this.emit({ type: "tts.duration_ms", value: networkResponse.durationMs });
      return { chunk, source: "network", durationMs: networkResponse.durationMs, latencyMs };
    } catch (networkError) {
      if (isTimeoutError(networkError)) this.emit({ type: "tts.request.timeout" });
      else this.emit({ type: "tts.request.failed", code: errorCode(networkError) });
      if (isMalformedAudioError(networkError)) return this.nonVerbalFallback(options, startedAt, "malformed_audio");
      this.lastErrorValue = networkError instanceof Error ? networkError.message : "network TTS failed";
      this.debug("network generation failed; trying local fallback", this.lastErrorValue);
    }

    await this.initialize();
    if (this.localReady && this.localModel) {
      this.setState("local");
      this.debug("local generation requested", { cueText: request.text, persona: request.persona });
      try {
        const localResponse = parseRealtimeTtsResponse(await this.localModel.generate(request));
        const chunk = makeTtsAudioChunk(localResponse, options.identity, options.cueId);
        const latencyMs = Math.max(0, this.nowMs() - startedAt);
        this.setState("ready", "local", latencyMs);
        this.emit({ type: "tts.request.success", source: "local", cached: false, durationMs: localResponse.durationMs });
        this.emit({ type: "tts.duration_ms", value: localResponse.durationMs });
        return { chunk, source: "local", durationMs: localResponse.durationMs, latencyMs };
      } catch (localError) {
        this.lastErrorValue = localError instanceof Error ? localError.message : "local TTS failed";
        this.emit({ type: "tts.request.failed", code: "local_generation_failed" });
        this.debug("local generation failed; using non-verbal fallback", this.lastErrorValue);
      }
    }

    return this.nonVerbalFallback(options, startedAt, "all_verbal_paths_failed");
  }

  /** Synchronous CueProvider compatibility path; predictive conductor calls generate(). */
  public createCue(identity: GenerationIdentity, cueId: string): AudioChunk {
    return createHumChunk(identity, cueId);
  }

  private async generateNetworkWithEmotionRetry(request: RealtimeTtsRequest): Promise<RealtimeTtsResponse> {
    try {
      return await this.generateNetwork(request);
    } catch (error) {
      if (!isUnsupportedEmotionError(error) || request.emotion === "neutral") throw error;
      this.emit({ type: "tts.emotion_unsupported", emotion: request.emotion });
      return this.generateNetwork({ ...request, emotion: "neutral" });
    }
  }

  private async generateNetwork(request: RealtimeTtsRequest): Promise<RealtimeTtsResponse> {
    const [authToken, appCheckToken] = await Promise.all([this.getAuthToken(), this.getAppCheckToken()]);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;

    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const requestPromise = this.fetchImpl(`${this.baseUrl}${REALTIME_TTS_ENDPOINT}`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        credentials: "omit",
        ...(controller ? { signal: controller.signal } : {}),
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error("realtime TTS network timeout"));
        }, this.networkTimeoutMs);
      });
      const response = await Promise.race([requestPromise, timeout]);
      if (!response.ok) throw new TtsHttpError(response.status);
      return parseRealtimeTtsResponse(await response.json());
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private store(key: string, response: RealtimeTtsResponse): void {
    this.cache.delete(key);
    this.cache.set(key, response);
    while (this.cache.size > MAX_TTS_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private nonVerbalFallback(options: RealtimeTtsGenerateOptions, startedAt: number, reason: string): GeneratedCue {
    const latencyMs = Math.max(0, this.nowMs() - startedAt);
    this.setState("fallback", "fallback", latencyMs);
    this.emit({ type: "tts.fallback.nonverbal", reason });
    this.emit({ type: "tts.duration_ms", value: 300 });
    this.debug("non-verbal fallback generated", { reason });
    return { chunk: createHumChunk(options.identity, options.cueId), source: "fallback", durationMs: 300, latencyMs };
  }

  private emit(event: TtsProviderEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.debug("telemetry event handler failed", error);
    }
  }

  private setState(state: TtsProviderState, source?: TtsGenerationSource, latencyMs?: number): void {
    this.stateValue = state;
    if (source !== undefined) this.sourceValue = source;
    if (latencyMs !== undefined) this.lastLatencyMsValue = latencyMs;
    this.onStateChange?.(state, source);
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_TTS && import.meta.env.DEV) console.debug(new Date().toISOString(), `[TTS] ${message}`, details ?? "");
  }
}

class TtsHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`realtime TTS backend returned HTTP ${status}`);
    this.name = "TtsHttpError";
  }
}

function isUnsupportedEmotionError(error: unknown): boolean {
  return error instanceof TtsHttpError && (error.status === 400 || error.status === 422);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("timeout");
}

function isMalformedAudioError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("audio") && (message.includes("pcm16") || message.includes("base64") || message.includes("duration"));
}

function errorCode(error: unknown): string {
  if (error instanceof TtsHttpError) return `http_${error.status}`;
  return "network_failed";
}

function cacheKey(request: RealtimeTtsRequest): string {
  return `${request.text}\u0000${request.persona}\u0000${request.emotion}`;
}

function createHumChunk(identity: GenerationIdentity, cueId: string): AudioChunk {
  const sampleRate = 24_000;
  const samples = new Int16Array(Math.round(sampleRate * 0.3));
  for (let index = 0; index < samples.length; index += 1) {
    const fade = Math.min(1, index / 480, (samples.length - index) / 480);
    samples[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.12 * 32_767 * fade);
  }
  return {
    chunkId: cueId,
    sequence: 0,
    format: "pcm_s16le",
    sampleRate,
    channels: 1,
    data: samples.buffer,
    audioLane: "backchannel",
    identity,
  };
}
