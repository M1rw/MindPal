import type { GenerationIdentity, AudioFrame } from "./core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "./core/message-bus";
import { CaptureManager, type CaptureMetrics } from "./layers/capture/capture-manager";
import { GeminiProviderAdapter } from "./layers/adapter/gemini-adapter";
import type { VoiceEvent } from "./layers/adapter/event-types";
import { MockTokenProvider, type TokenProvider } from "./layers/transport/token-provider";
import {
  WebSocketTransportManager,
  type TransportEvent,
  type TransportSnapshot,
  type WsManagerOptions,
} from "./layers/transport/ws-manager";
import {
  PlaybackManager,
  type PlaybackEvent,
  type PlaybackSnapshot,
  type PlaybackManagerOptions,
} from "./layers/playback/playback-manager";
import { BackchannelConductor } from "./layers/backchannel/conductor";
import { VoiceOrchestrator } from "./layers/orchestrator/orchestrator";
import { AssistantAssembler } from "./layers/transcript/assistant-assembler";
import { UserAssembler } from "./layers/transcript/user-assembler";
import { CaptionPacer } from "./layers/caption/pacer";
import { MockGeminiServer } from "./debug/mock-gemini-server";
import { SyntheticCueProvider, type CueProvider } from "./layers/backchannel/cue-provider";
import { RealTokenProvider, type RealTokenProviderOptions } from "./integration/real-token-provider";
import type { RealtimeTTSProviderOptions } from "./layers/backchannel/realtime-tts-provider";
import type { TtsEmotion } from "./integration/tts-endpoint-contract";
import { ProsodyAnalyzer } from "./layers/prosody/prosody-analyzer";
import { DEFAULT_VOICE_V3_FEATURE_FLAGS, type VoiceV3FeatureFlags } from "./integration/feature-flags";
import { LocalMemoryStore, type LocalMemoryRecord } from "./layers/memory/local-memory-store";
import { MemoryExtractor } from "./layers/memory/memory-extractor";

export const PRODUCTION_MODE = import.meta.env.PROD;
export type VoiceProviderMode = "mock" | "real";

export type VoiceV3AppOptions = {
  readonly providerMode?: VoiceProviderMode;
  readonly mockServer?: MockGeminiServer;
  readonly nowMono?: () => number;
  readonly audioContextFactory?: () => AudioContext;
  readonly productionMode?: boolean;
  readonly tokenProvider?: TokenProvider;
  readonly cueProvider?: CueProvider;
  readonly baseUrl?: string;
  readonly getAuthToken?: () => Promise<string | null>;
  readonly getAppCheckToken?: () => Promise<string | null>;
  readonly refreshAuthToken?: () => Promise<string | null>;
  readonly refreshAppCheckToken?: () => Promise<string | null>;
  readonly voicePersona?: string;
  readonly voiceEmotion?: TtsEmotion;
  /** @deprecated External TTS is not used by default; inject cueProvider only for legacy tests. */
  readonly realtimeTtsOptions?: Omit<RealtimeTTSProviderOptions, "baseUrl" | "getAuthToken" | "getAppCheckToken">;
  readonly featureFlags?: VoiceV3FeatureFlags;
  readonly memoryUserId?: string;
  readonly incognito?: boolean;
  readonly memoryStore?: LocalMemoryStore;
};

export type VoiceV3StartOptions = {
  readonly startCapture?: boolean;
};

const DEFAULT_IDENTITY: GenerationIdentity = {
  sessionGeneration: "debug-session",
  turnId: null,
  providerResponseId: null,
  playbackGeneration: null,
};

/**
 * Single Voice V3 composition root. Construction order intentionally follows
 * the protocol: bus → security/token → transport → adapter → orchestrator →
 * playback → transcript/caption → backchannel → capture.
 */
export class VoiceV3App {
  public readonly providerMode: VoiceProviderMode;
  public readonly bus: LayerLinkMessageBus;
  public readonly transportManager: WebSocketTransportManager;
  public readonly adapter: GeminiProviderAdapter;
  public readonly orchestrator: VoiceOrchestrator;
  public readonly playbackManager: PlaybackManager;
  public readonly assistantAssembler: AssistantAssembler;
  public readonly userAssembler: UserAssembler;
  public readonly captionPacer: CaptionPacer;
  public readonly conductor: BackchannelConductor;
  public readonly captureManager: CaptureManager;
  public readonly prosodyAnalyzer: ProsodyAnalyzer;
  public readonly mockServer: MockGeminiServer | null;
  public readonly cueProvider: CueProvider;
  public readonly featureFlags: VoiceV3FeatureFlags;
  public readonly memoryStore: LocalMemoryStore | null;
  public readonly memoryExtractor: MemoryExtractor | null;

  private readonly nowMono: () => number;
  private readonly unsubscriber: () => void;
  private started = false;
  private lastUserTranscript: string | null = null;
  private nativeCueActive = false;
  private nativeCueResponseId: string | null = null;
  private lastMemoryContext: string | null = null;
  private lastMemoryRecord: LocalMemoryRecord | null = null;

  public constructor(options: VoiceV3AppOptions = {}) {
    const productionMode = options.productionMode ?? (PRODUCTION_MODE || options.providerMode === "real");
    this.providerMode = options.providerMode ?? (productionMode ? "real" : "mock");
    this.featureFlags = options.featureFlags ?? {
      ...DEFAULT_VOICE_V3_FEATURE_FLAGS,
      VOICE_V3_ENABLED: this.providerMode === "mock",
    };
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.mockServer = this.providerMode === "mock" ? options.mockServer ?? new MockGeminiServer({ nowMono: this.nowMono }) : null;
    const memoryEnabled = this.featureFlags.VOICE_V3_MEMORY_ENABLED && !options.incognito && Boolean(options.memoryUserId);
    this.memoryStore = memoryEnabled ? options.memoryStore ?? new LocalMemoryStore({ userId: options.memoryUserId as string }) : null;
    this.memoryExtractor = this.memoryStore
      ? new MemoryExtractor({
          store: this.memoryStore,
          onEvent: (event) => this.publishMemoryEvent(event),
        })
      : null;

    // 1. LayerLink Message Bus
    this.bus = new LayerLinkMessageBus({
      nowMono: this.nowMono,
      onDiagnostic: (diagnostic) => this.debug("[LayerLink]", diagnostic),
    });

    // 2. Security/Token Provider (mock in this isolated V3 workspace)
    const tokenProvider = options.tokenProvider
      ?? this.mockServer?.tokenProvider
      ?? (this.providerMode === "real"
        ? createRealTokenProvider(options)
        : new MockTokenProvider({ nowMono: this.nowMono }));

    // 3. Transport Layer
    let adapter: GeminiProviderAdapter | null = null;
    const baseTransportOptions = {
      tokenProvider,
      nowMono: this.nowMono,
      onEvent: (event: TransportEvent) => this.publishTransport(event),
      onSnapshot: (snapshot: TransportSnapshot) => this.publishTransportSnapshot(snapshot),
      onProviderMessage: (rawMessage: unknown) => {
        const normalized = adapter?.normalize(rawMessage) ?? [];
        for (const event of normalized) this.publishProviderEvent(event);
      },
      ...(options.voicePersona === undefined ? {} : { voicePersona: options.voicePersona }),
      ...(this.memoryExtractor === null ? {} : {
        getSetupContext: async () => this.loadMemoryContext(),
      }),
    };
    const transportOptions: WsManagerOptions = this.mockServer
      ? { ...baseTransportOptions, webSocketFactory: this.mockServer.createWebSocketFactory() }
      : baseTransportOptions;
    this.transportManager = new WebSocketTransportManager(transportOptions);

    // 4. Provider Adapter
    this.adapter = new GeminiProviderAdapter();
    adapter = this.adapter;

    // 5. Orchestrator
    this.orchestrator = new VoiceOrchestrator({
      bus: this.bus,
      nowMono: this.nowMono,
      sessionGeneration: "session-1",
    });

    // 6. Playback Layer
    const basePlaybackOptions = {
      nowMono: this.nowMono,
      onEvent: (event: PlaybackEvent) => this.publishPlayback(event),
      onSnapshot: (snapshot: PlaybackSnapshot) => this.publishPlaybackSnapshot(snapshot),
    };
    const playbackOptions: PlaybackManagerOptions = options.audioContextFactory
      ? { ...basePlaybackOptions, audioContextFactory: options.audioContextFactory }
      : basePlaybackOptions;
    this.playbackManager = new PlaybackManager(playbackOptions);

    // 7. Transcript & Caption Layers
    this.assistantAssembler = new AssistantAssembler({
      onUpdate: (update) => this.publish("transcript", `transcript.${update.speaker}.updated`, update),
      onDiagnostic: (diagnostic) => this.publish("transcript", diagnostic.type, diagnostic),
    });
    this.userAssembler = new UserAssembler({
      onUpdate: (update) => this.publish("transcript", `transcript.${update.speaker}.updated`, update),
      onDiagnostic: (diagnostic) => this.publish("transcript", diagnostic.type, diagnostic),
    });
    this.captionPacer = new CaptionPacer({
      bus: this.bus,
      assistantAssembler: this.assistantAssembler,
      nowMono: this.nowMono,
    });

    // 8. Backchannel Conductor
    // Gemini Native Audio is the sole production voice source. The provider
    // remains injectable for deterministic legacy tests, but CAMB/TTS is not
    // constructed or contacted by the default V3 composition root.
    this.cueProvider = options.cueProvider ?? new SyntheticCueProvider();
    const conductorOptions = {
      bus: this.bus,
      cueProvider: this.cueProvider,
      nowMono: this.nowMono,
      identity: DEFAULT_IDENTITY,
      ...(options.voicePersona === undefined ? {} : { voicePersona: options.voicePersona }),
      ...(options.voiceEmotion === undefined ? {} : { emotion: options.voiceEmotion }),
      nativeGeminiCues: true,
    };
    this.conductor = new BackchannelConductor(conductorOptions);

    // 9. Local Prosody & Emotional Context Layer
    this.prosodyAnalyzer = new ProsodyAnalyzer({ bus: this.bus, nowMono: this.nowMono });

    // 10. Capture Layer
    this.captureManager = new CaptureManager({
      onMetrics: (metrics) => this.publishCaptureMetrics(metrics),
      onFrame: (frame) => {
        this.publish("capture", "capture.frame", frame);
        this.transportManager.sendAudioFrame(frame);
      },
      onDiagnostic: (diagnostic) => this.debug("[Capture]", diagnostic),
    });

    this.unsubscriber = this.bus.subscribe<unknown>((envelope) => this.routeOrchestratorCommand(envelope), {});
  }

  public async start(options: VoiceV3StartOptions = {}): Promise<void> {
    if (!this.featureFlags.VOICE_V3_ENABLED) return;
    if (this.started) return;
    this.started = true;
    this.orchestrator.startSession();
    this.orchestrator.markProvisioning();
    this.orchestrator.markConnecting();
    try {
      try {
        await this.transportManager.connect();
      } catch (primaryError) {
        if (!isFallbackHandshakeFailure(primaryError) || this.providerMode !== "real") throw primaryError;
        this.debug("[Voice V3] primary Gemini handshake failed; trying configured fallback", {
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        });
        await this.transportManager.connectFallback();
      }
      if (!this.transportManager.isReady) throw new Error("transport did not become ready");
      await initializeCueProvider(this.cueProvider);
      if (this.mockServer) this.orchestrator.markGreetingSent();
      else this.orchestrator.requestGreeting();
      if (options.startCapture !== false) await this.captureManager.start();
    } catch (error) {
      this.orchestrator.fail(error instanceof Error ? error.message : "Voice V3 failed to start");
      this.started = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    await this.captureManager.stop();
    this.orchestrator.close();
    this.transportManager.close();
    this.started = false;
  }

  public setMuted(muted: boolean): void {
    this.captureManager.setMuted(muted);
  }

  /** Sends one explicitly bounded acknowledgement request through the active Gemini session. */
  public requestGeminiNativeCue(cueText: string): boolean {
    const normalized = cueText.trim().slice(0, 80);
    if (!normalized) return false;
    this.nativeCueActive = true;
    this.nativeCueResponseId = null;
    const sent = this.transportManager.sendRealtimeText(`VOICE_CUE_REQUEST: ${normalized}`);
    if (sent) {
      this.publish("backchannel", "backchannel.native.requested", {
        cueText: normalized,
        identity: this.orchestrator.identity,
      });
    } else {
      this.nativeCueActive = false;
      this.nativeCueResponseId = null;
    }
    return sent;
  }

  public async clearMemory(): Promise<void> {
    await this.memoryExtractor?.clear();
    this.lastMemoryRecord = null;
    this.lastMemoryContext = null;
    this.publishMemorySnapshot({ userId: "", lastUpdated: 0, keyFacts: [], preferences: [] });
  }

  public get memorySnapshot(): { readonly record: LocalMemoryRecord | null; readonly injectedContext: string | null; readonly extractionCount: number } {
    return {
      record: this.lastMemoryRecord,
      injectedContext: this.lastMemoryContext,
      extractionCount: this.memoryExtractor?.extractionCount ?? 0,
    };
  }

  public simulateInterruption(): void {
    this.mockServer?.simulateInterruption();
  }

  public simulateTurnComplete(): void {
    this.mockServer?.simulateTurnComplete();
  }

  public simulateUserSpeech(frameCount = 150): void {
    if (!this.mockServer) return;
    const start = this.nowMono();
    for (let index = 0; index < frameCount; index += 1) {
      const capturedAtMono = start + index * 20;
      const frame: AudioFrame = {
        frameId: `mock-capture-${index}`,
        sequence: index,
        sampleRate: 16_000,
        channels: 1,
        format: "pcm_s16le",
        data: new ArrayBuffer(640),
        capturedAtMono,
        durationMs: 20,
        muted: false,
        rms: 0.1,
      };
      this.publish("capture", "capture.frame", frame, {
        ...DEFAULT_IDENTITY,
        sessionGeneration: this.orchestrator.identity.sessionGeneration,
      });
    }
    this.mockServer.simulateUserSpeech(frameCount);
  }

  public dispose(): void {
    this.unsubscriber();
    this.captureManager.stop().catch(() => undefined);
    this.transportManager.close();
    this.captionPacer.dispose();
    this.conductor.dispose();
    this.prosodyAnalyzer.dispose();
    this.orchestrator.dispose();
    this.mockServer?.close();
  }

  private routeOrchestratorCommand(envelope: { readonly messageType: string; readonly payload: unknown }): void {
    if (envelope.messageType === "ORCHESTRATOR_AUDIO_EVENT") {
      const payload = envelope.payload as { readonly event?: VoiceEvent };
      if (payload.event?.type === "PROVIDER_AUDIO") {
        const isNativeCue = this.nativeCueActive &&
          (this.nativeCueResponseId === null || payload.event.identity.providerResponseId === this.nativeCueResponseId);
        void this.playbackManager.enqueueProviderAudio(
          payload.event.payload,
          payload.event.identity,
          isNativeCue ? "backchannel" : "main",
        );
      }
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_FLUSH_PLAYBACK") {
      const payload = envelope.payload as { readonly oldPlaybackGeneration?: string | null };
      if (payload.oldPlaybackGeneration) this.playbackManager.flush(payload.oldPlaybackGeneration);
      this.playbackManager.duckMainLane();
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_GEMINI_CUE_REQUESTED") {
      const payload = envelope.payload as { readonly cueText?: unknown; readonly identity?: GenerationIdentity };
      if (typeof payload.cueText !== "string") return;
      const cueText = payload.cueText.trim().slice(0, 80);
      if (!cueText) return;
      this.requestGeminiNativeCue(cueText);
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_GEMINI_CUE_COMPLETE") {
      this.nativeCueActive = false;
      this.nativeCueResponseId = null;
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_BACKCHANNEL_CUE") {
      const payload = envelope.payload as { readonly cue?: Parameters<PlaybackManager["enqueueChunk"]>[0] };
      if (payload.cue) void this.playbackManager.enqueueChunk(payload.cue);
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_TRANSCRIPT_EVENT") {
      const payload = envelope.payload as { readonly event?: VoiceEvent };
      if (payload.event?.type === "PROVIDER_INPUT_TRANSCRIPT") {
        const update = this.userAssembler.consume(payload.event);
        if (update) this.lastUserTranscript = update.text;
      }
      if (payload.event?.type === "PROVIDER_TURN_COMPLETE") {
        const transcript = this.lastUserTranscript;
        this.lastUserTranscript = null;
        if (transcript && this.memoryExtractor) {
          void this.memoryExtractor.processTurnComplete(transcript)
            .then(() => this.memoryStore?.get())
            .then((record) => {
              if (record) {
                this.lastMemoryRecord = record;
                this.publishMemorySnapshot(record);
              }
            })
            .catch((error) => this.debug("[Memory] extraction failed", { error: error instanceof Error ? error.message : String(error) }));
        }
        this.playbackManager.restoreMainLane();
        this.captionPacer.closeTurn(payload.event.identity);
      }
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_GREETING_REQUESTED") {
      this.transportManager.sendControl({ type: "greeting", greeting: true, identity: this.orchestrator.identity });
      return;
    }
    if (envelope.messageType === "ORCHESTRATOR_CLOSE_REQUESTED") {
      this.transportManager.close();
    }
    if (envelope.messageType === "prosody.context.note") {
      if (!this.featureFlags.VOICE_V3_PROSODY_CONTEXT_ENABLED) return;
      const payload = envelope.payload as { readonly note?: unknown };
      if (typeof payload.note === "string" && payload.note.length <= 200) {
        this.transportManager.sendRealtimeText(payload.note);
      }
      return;
    }
    if (envelope.messageType === "prosody.state.updated") {
      if (isProsodyStatePayload(envelope.payload)) this.playbackManager.setProsodyState(envelope.payload);
      return;
    }
  }

  private publishProviderEvent(event: VoiceEvent): void {
    if (this.nativeCueActive && event.type === "PROVIDER_AUDIO") {
      this.nativeCueResponseId = event.identity.providerResponseId;
    }
    const isNativeCueTranscript = this.nativeCueActive &&
      event.type === "PROVIDER_OUTPUT_TRANSCRIPT" &&
      (this.nativeCueResponseId === null || event.identity.providerResponseId === this.nativeCueResponseId);
    if (!isNativeCueTranscript) this.publish("provider-adapter", event.type, event);
    this.publish("provider-adapter", "adapter.event", event);
    if (event.type === "PROVIDER_TURN_COMPLETE" || event.type === "PROVIDER_INTERRUPTED") {
      this.nativeCueActive = false;
      this.nativeCueResponseId = null;
    }
  }

  private publishTransport(event: TransportEvent): void {
    this.publish("transport", event.type, event);
  }

  private publishTransportSnapshot(snapshot: TransportSnapshot): void {
    this.publish("transport", "transport.snapshot.updated", snapshot);
  }

  private publishPlayback(event: PlaybackEvent): void {
    const messageType = event.type === "playback.scheduled" ? "playback.chunk-scheduled" : event.type;
    this.publish("playback", messageType, event);
  }

  private publishPlaybackSnapshot(snapshot: PlaybackSnapshot): void {
    this.publish("playback", "playback.snapshot.updated", snapshot);
    this.publish("playback", "playback.state", snapshot);
  }

  private publishCaptureMetrics(metrics: CaptureMetrics): void {
    this.publish("capture", "capture.metrics.updated", metrics);
  }

  private async loadMemoryContext(): Promise<string | null> {
    try {
      const context = await this.memoryExtractor?.buildContext();
      if (!context) return null;
      this.lastMemoryRecord = context.record;
      this.lastMemoryContext = context.text;
      this.publishMemorySnapshot(context.record);
      return context.text;
    } catch (error) {
      this.debug("[Memory] setup context unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private publishMemoryEvent(event: { readonly type: string; readonly keyFactCount?: number; readonly preferenceCount?: number; readonly characterCount?: number }): void {
    const { type, ...metrics } = event;
    this.publish("memory", type, metrics);
  }

  private publishMemorySnapshot(record: LocalMemoryRecord): void {
    this.publish("memory", "memory.snapshot.updated", {
      record,
      injectedContext: this.lastMemoryContext,
      extractionCount: this.memoryExtractor?.extractionCount ?? 0,
    });
  }

  private publish(
    sourceLayer: "capture" | "transport" | "provider-adapter" | "playback" | "backchannel" | "prosody" | "memory" | "transcript" | "caption",
    messageType: string,
    payload: unknown,
    identity: GenerationIdentity = this.orchestrator?.identity ?? DEFAULT_IDENTITY,
  ): void {
    const topic = sourceLayer === "capture"
      ? "voice.capture"
      : sourceLayer === "transport"
        ? "voice.transport"
        : sourceLayer === "provider-adapter"
          ? "voice.provider"
          : sourceLayer === "playback"
            ? "voice.playback"
              : sourceLayer === "backchannel"
                ? "voice.backchannel"
                : sourceLayer === "prosody"
                  ? "voice.prosody"
                  : sourceLayer === "memory"
                    ? "voice.memory"
                    : sourceLayer === "transcript"
                ? "voice.transcript"
                : "voice.caption";
    this.bus.publish(
      createEventEnvelope({
        messageId: `${messageType}-${this.nowMono()}-${Math.random().toString(36).slice(2)}`,
        messageType,
        sourceLayer,
        topic,
        priority: "telemetry",
        timestampMono: this.nowMono(),
        ttlMs: 10_000,
        identity,
        correlationId: "voice-v3-app",
        payload,
      }),
    );
  }

  private debug(label: string, detail: unknown): void {
    if (import.meta.env.DEV) console.debug(label, detail);
  }
}

function createRealTokenProvider(options: VoiceV3AppOptions): RealTokenProvider {
  const tokenOptions: RealTokenProviderOptions = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.getAuthToken === undefined ? {} : { getAuthToken: options.getAuthToken }),
    ...(options.getAppCheckToken === undefined ? {} : { getAppCheckToken: options.getAppCheckToken }),
    ...(options.refreshAuthToken === undefined ? {} : { refreshAuthToken: options.refreshAuthToken }),
    ...(options.refreshAppCheckToken === undefined ? {} : { refreshAppCheckToken: options.refreshAppCheckToken }),
  };
  return new RealTokenProvider(tokenOptions);
}

function isProsodyStatePayload(value: unknown): value is import("./layers/prosody/prosody-state").ProsodyState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<import("./layers/prosody/prosody-state").ProsodyState>;
  return typeof candidate.energyLevel === "string" && typeof candidate.speechRate === "string" &&
    typeof candidate.pausePattern === "string" && typeof candidate.emotionalGuess === "string" &&
    typeof candidate.confidence === "number" && typeof candidate.lastChangedAtMono === "number";
}

function isFallbackHandshakeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /setupComplete timeout|WebSocket closed:\s*(1006|1011|1013)/i.test(message);
}

async function initializeCueProvider(provider: CueProvider): Promise<void> {
  const candidate = provider as CueProvider & { readonly initialize?: () => Promise<void>; readonly preload?: () => Promise<void> };
  if (candidate.initialize) await candidate.initialize();
  else if (candidate.preload) await candidate.preload();
}

export function createVoiceV3App(options: VoiceV3AppOptions = {}): VoiceV3App {
  return new VoiceV3App(options);
}
