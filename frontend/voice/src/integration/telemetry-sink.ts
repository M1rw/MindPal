import type { LayerLinkEnvelope } from "../core/layer-link";
import type { LayerLinkMessageBus } from "../core/message-bus";

export type TelemetrySinkOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly getAuthToken?: () => Promise<string | null>;
  readonly getAppCheckToken?: () => Promise<string | null>;
  readonly flushIntervalMs?: number;
  readonly nowMs?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type TelemetryMetrics = {
  readonly model: string;
  readonly audioParts: number;
  readonly inputTranscriptionEvents: number;
  readonly outputTranscriptionEvents: number;
  readonly transcriptCallbackEvents: number;
  readonly modelTextParts: number;
  readonly turnCompleteEvents: number;
  readonly interruptedEvents: number;
  readonly factGatedAudioParts: number;
  readonly staleRejections: number;
  readonly playbackUnderruns: number;
  readonly captionDriftSamples: number;
  readonly captionDriftTotalMs: number;
  readonly stateTransitions: Readonly<Record<string, number>>;
  readonly errorCodes: Readonly<Record<string, number>>;
  readonly queueDepthSamples: number;
  readonly queueDepthTotalMs: number;
};

export type VoiceDeliveryDiagnosticRequest = {
  readonly model: string;
  readonly audio_parts: number;
  readonly input_transcription_events: number;
  readonly output_transcription_events: number;
  readonly transcript_callback_events: number;
  readonly model_text_parts: number;
  readonly turn_complete_events: number;
  readonly interrupted_events: number;
  readonly fact_gated_audio_parts: number;
  readonly end_reason: string;
};

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

/**
 * Batches numeric delivery diagnostics only. The handler intentionally never
 * reads transcript text, PCM bytes, base64 audio, or provider content fields.
 */
export class TelemetrySink {
  private readonly bus: LayerLinkMessageBus;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken: () => Promise<string | null>;
  private readonly getAppCheckToken: () => Promise<string | null>;
  private readonly flushIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private metrics: MutableTelemetryMetrics = createMetrics(DEFAULT_MODEL);
  private flushing: Promise<void> | null = null;
  private closed = false;

  public constructor(options: TelemetrySinkOptions) {
    this.bus = options.bus;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getAuthToken = options.getAuthToken ?? (async () => null);
    this.getAppCheckToken = options.getAppCheckToken ?? (async () => null);
    this.flushIntervalMs = Math.max(100, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.metrics = createMetrics(this.model);
    this.unsubscribe = this.bus.subscribe<unknown>((envelope) => this.observe(envelope), {});
    this.scheduleNextFlush();
  }

  public get snapshot(): TelemetryMetrics {
    return cloneMetrics(this.metrics);
  }

  public async flush(endReason = "interval", force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    const request = toRequest(this.metrics, endReason);
    if (!force && !hasActivity(request)) return;
    this.metrics = createMetrics(this.model);
    this.flushing = this.send(request).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  public async close(endReason = "session_closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.flush(endReason, true);
  }

  private observe(envelope: LayerLinkEnvelope<unknown>): void {
    if (this.closed) return;
    const type = envelope.messageType;
    if (type === "PROVIDER_AUDIO") this.metrics.audioParts += 1;
    else if (type === "PROVIDER_INPUT_TRANSCRIPT") {
      this.metrics.inputTranscriptionEvents += 1;
      this.metrics.transcriptCallbackEvents += 1;
    } else if (type === "PROVIDER_OUTPUT_TRANSCRIPT") {
      this.metrics.outputTranscriptionEvents += 1;
      this.metrics.modelTextParts += 1;
    } else if (type === "PROVIDER_TURN_COMPLETE") this.metrics.turnCompleteEvents += 1;
    else if (type === "PROVIDER_INTERRUPTED") this.metrics.interruptedEvents += 1;
    else if (type === "ORCHESTRATOR_STALE_REJECTED" || type === "playback.stale_chunk.rejected" || type === "caption.stale.rejected") {
      this.metrics.staleRejections += 1;
    } else if (type === "playback.underrun") {
      this.metrics.playbackUnderruns += 1;
    } else if (type === "ORCHESTRATOR_STATE_CHANGED") {
      const payload = asRecord(envelope.payload);
      const to = typeof payload?.to === "string" ? payload.to : "unknown";
      increment(this.metrics.stateTransitions, to);
    } else if (type === "transport.error" || type === "playback.error" || type === "ORCHESTRATOR_FAILED") {
      const payload = asRecord(envelope.payload);
      const reason = typeof payload?.reason === "string" ? sanitizeCode(payload.reason) : type;
      increment(this.metrics.errorCodes, reason);
    } else if (type === "playback.snapshot.updated" || type === "playback.scheduled") {
      const payload = asRecord(envelope.payload);
      const queueDepthMs = typeof payload?.queueDepthMs === "number" ? payload.queueDepthMs : null;
      if (queueDepthMs !== null && Number.isFinite(queueDepthMs)) {
        this.metrics.queueDepthSamples += 1;
        this.metrics.queueDepthTotalMs += Math.max(0, Math.min(queueDepthMs, 60_000));
      }
    } else if (type === "caption.released") {
      const payload = asRecord(envelope.payload);
      const caption = asRecord(payload?.caption);
      const drift = typeof caption?.driftEstimateMs === "number" ? caption.driftEstimateMs : null;
      if (drift !== null && Number.isFinite(drift)) {
        this.metrics.captionDriftSamples += 1;
        this.metrics.captionDriftTotalMs += Math.max(0, Math.min(drift, 60_000));
      }
    }
  }

  private scheduleNextFlush(): void {
    if (this.closed) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush("interval").catch(() => undefined).finally(() => this.scheduleNextFlush());
    }, this.flushIntervalMs);
  }

  private async send(request: VoiceDeliveryDiagnosticRequest): Promise<void> {
    const [authToken, appCheckToken] = await Promise.all([this.getAuthToken(), this.getAppCheckToken()]);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
    const response = await this.fetchImpl(`${this.baseUrl}/api/voice/delivery-diagnostic`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      keepalive: request.end_reason !== "interval",
      credentials: "omit",
    });
    if (!response.ok) throw new Error(`Voice telemetry request failed with HTTP ${response.status}`);
  }
}

function createMetrics(model: string): MutableTelemetryMetrics {
  return {
    model,
    audioParts: 0,
    inputTranscriptionEvents: 0,
    outputTranscriptionEvents: 0,
    transcriptCallbackEvents: 0,
    modelTextParts: 0,
    turnCompleteEvents: 0,
    interruptedEvents: 0,
    factGatedAudioParts: 0,
    staleRejections: 0,
    playbackUnderruns: 0,
    captionDriftSamples: 0,
    captionDriftTotalMs: 0,
    stateTransitions: Object.create(null) as Record<string, number>,
    errorCodes: Object.create(null) as Record<string, number>,
    queueDepthSamples: 0,
    queueDepthTotalMs: 0,
  };
}

type MutableTelemetryMetrics = {
  -readonly [Key in keyof TelemetryMetrics]: TelemetryMetrics[Key] extends Readonly<Record<string, number>> ? Record<string, number> : TelemetryMetrics[Key];
};

function toRequest(metrics: MutableTelemetryMetrics, endReason: string): VoiceDeliveryDiagnosticRequest {
  return {
    model: metrics.model,
    audio_parts: metrics.audioParts,
    input_transcription_events: metrics.inputTranscriptionEvents,
    output_transcription_events: metrics.outputTranscriptionEvents,
    transcript_callback_events: metrics.transcriptCallbackEvents,
    model_text_parts: metrics.modelTextParts,
    turn_complete_events: metrics.turnCompleteEvents,
    interrupted_events: metrics.interruptedEvents,
    fact_gated_audio_parts: metrics.factGatedAudioParts,
    end_reason: sanitizeCode(endReason),
  };
}

function hasActivity(request: VoiceDeliveryDiagnosticRequest): boolean {
  return Object.entries(request).some(([key, value]) => key !== "model" && key !== "end_reason" && typeof value === "number" && value > 0);
}

function cloneMetrics(metrics: MutableTelemetryMetrics): TelemetryMetrics {
  return {
    ...metrics,
    stateTransitions: { ...metrics.stateTransitions },
    errorCodes: { ...metrics.errorCodes },
  };
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function sanitizeCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 120) || "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
