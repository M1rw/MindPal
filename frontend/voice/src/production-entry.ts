import { createVoiceV3App, type VoiceV3App } from "./app";
import type { AudioFrame, LayerLinkEnvelope } from "./core/layer-link";
import { DEFAULT_VOICE_V3_FEATURE_FLAGS } from "./integration/feature-flags";
import type { OrchestratorSnapshot } from "./layers/orchestrator/orchestrator";
import type { VoiceEvent } from "./layers/adapter/event-types";
import type { AffectState } from "./layers/affect/affect-engine";

type VoiceCallback = (...args: any[]) => void;

type ProductionSessionOptions = {
  readonly contextProvider?: unknown;
  readonly token?: string | null;
  readonly getAuthToken?: (() => Promise<string | null>) | null;
  readonly refreshAuthToken?: (() => Promise<string | null>) | null;
  readonly getAppCheckToken?: (() => Promise<string | null>) | null;
  readonly refreshAppCheckToken?: (() => Promise<string | null>) | null;
  readonly onTranscript?: (speaker: "user" | "ai", text: string) => void;
  readonly onCaption?: (text: string, detail: Record<string, unknown>) => void;
  readonly onAudioState?: (state: Record<string, unknown>) => void;
  readonly onSessionEnd?: (detail?: Record<string, unknown>) => void;
  readonly onTurnComplete?: () => void;
  readonly onBackgroundTask?: (detail: Record<string, unknown>) => void;
  readonly onVolume?: (detail: Record<string, unknown>) => void;
  readonly onDiagnostic?: (detail: Record<string, unknown>) => void;
};

type ProductionController = {
  startSession: (options?: ProductionSessionOptions) => Promise<boolean>;
  stopSession: () => Promise<boolean>;
  setMuted: (muted: boolean) => boolean;
  setSpeakerMuted: (muted: boolean) => boolean;
  sendTextToModel: (text: string) => boolean;
  injectAudioFrame: (frame: AudioFrame) => boolean;
  endAudioStream: () => boolean;
  setNativeCaptureSuppressed: (suppressed: boolean) => void;
  getSessionState: () => Record<string, unknown>;
  getSessionDebugReport: () => Record<string, unknown>;
  getTranscriptSnapshot: () => { userTranscript: string; aiTranscript: string };
  getMicMuted: () => boolean;
  getAiSpeaking: () => boolean;
  getSpeakerMuted: () => boolean;
};

type RuntimeGlobal = {
  createVoiceController: () => ProductionController;
};

declare global {
  interface Window {
    __MINDPAL_VOICE_RUNTIME__?: RuntimeGlobal;
  }
}

const INITIAL_STATE: Record<string, unknown> = {
  isActive: false,
  isMicMuted: false,
  isAiSpeaking: false,
  isSpeakerMuted: false,
  phase: "idle",
  reconnectAttempts: 0,
  micAnalyser: null,
  aiAnalyser: null,
};

export function createVoiceController(): ProductionController {
  let app: VoiceV3App | null = null;
  let active = false;
  let micMuted = false;
  let speakerMuted = false;
  let aiSpeaking = false;
  let phase = "idle";
  let reconnectAttempts = 0;
  let userTranscript = "";
  let aiTranscript = "";
  let callbacks: ProductionSessionOptions = {};
  let unsubscribe: (() => void) | null = null;
  let sessionEndNotified = false;
  let startupPending = false;
  let stopInFlight: Promise<boolean> | null = null;
  let inputWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  // Session Debug Telemetry State
  let sessionId = "";
  let startTimeMs = 0;
  let endTimeMs = 0;
  let diagnosticsLog: Array<Record<string, unknown>> = [];
  let turnHistory: Array<{
    speaker: "user" | "ai";
    text: string;
    timestamp: string;
  }> = [];
  let chunksScheduled = 0;
  let framesCaptured = 0;
  let flushesCount = 0;
  let interruptionsCount = 0;
  let lastRms = 0;
  let transportFramesSent = 0;
  let transportReady = false;
  let transportState = "IDLE";
  let recentTransportMessageTypes: string[] = [];

  const emitAudioState = (): void => {
    const faceState = app?.faceLayer.processPhaseAndState(
      phase,
      aiSpeaking,
      micMuted,
    );
    callbacks.onAudioState?.({
      phase,
      isAiSpeaking: aiSpeaking,
      isMicMuted: micMuted,
      palette: aiSpeaking ? "speak" : "listen",
      interactionTag: app?.affectEngine.state.stance ?? "steady-neutral",
      affect: app?.affectEngine.state ?? null,
      reconnectAttempts,
      faceExpression: faceState?.expression || "neutral",
      faceTheme: faceState?.theme || "geminiCore",
      faceState,
    });
  };

  const notifySessionEnd = (reason: string): void => {
    if (sessionEndNotified) return;
    sessionEndNotified = true;
    endTimeMs = Date.now();
    callbacks.onSessionEnd?.({ reason });
  };

  const clearInputWatchdog = (): void => {
    if (inputWatchdogTimer !== null) {
      clearTimeout(inputWatchdogTimer);
      inputWatchdogTimer = null;
    }
  };

  const armInputWatchdog = (): void => {
    clearInputWatchdog();
    inputWatchdogTimer = setTimeout(() => {
      inputWatchdogTimer = null;
      const actualCaptureFrames = Math.max(
        framesCaptured,
        app?.captureManager.getMetrics().framesEmitted ?? 0,
      );
      const noCaptureFrames = framesCaptured === 0 && actualCaptureFrames === 0;
      const noTransportFrames = transportFramesSent === 0;
      if (
        !active ||
        micMuted ||
        userTranscript.trim() ||
        (!noCaptureFrames && !noTransportFrames)
      )
        return;
      recordDiagnostic({
        type: "voice.input.waiting",
        reason: noCaptureFrames
          ? "no-microphone-frames"
          : "capture-before-transport-ready",
        framesCaptured: actualCaptureFrames,
        transportFramesSent,
        transportReady,
        transportState,
      });
    }, 5_000);
  };

  const recordDiagnostic = (detail: Record<string, unknown>): void => {
    diagnosticsLog.push({ ...detail, timestamp: new Date().toISOString() });
    if (diagnosticsLog.length > 200) diagnosticsLog.shift();
    callbacks.onDiagnostic?.(detail);
  };

  const getSessionDebugReport = (): Record<string, unknown> => {
    const now = endTimeMs > 0 ? endTimeMs : Date.now();
    const durationMs = startTimeMs > 0 ? now - startTimeMs : 0;
    const memory = app?.memorySnapshot || null;
    const affect: AffectState | null = app?.affectSnapshot ?? null;
    // Read the transport object directly as well as the event-driven cache.
    // Fixture and capture frames can be sent in a tight browser turn; the
    // direct snapshot keeps diagnostics truthful even if bus telemetry is
    // briefly behind the WebSocket counter.
    const liveTransport = app?.transportManager.snapshot;

    return {
      sessionId,
      startTime: startTimeMs > 0 ? new Date(startTimeMs).toISOString() : null,
      endTime: now > 0 ? new Date(now).toISOString() : null,
      durationMs,
      durationFormatted: `${(durationMs / 1000).toFixed(1)}s`,
      transcripts: {
        userTranscript,
        aiTranscript,
        turns: [...turnHistory],
        turnCount: turnHistory.length,
      },
      audioMetrics: {
        framesCaptured,
        chunksScheduled,
        interruptionsCount,
        flushesCount,
        lastRms,
        aiOutputLevel: app?.playbackManager.getOutputLevel?.() ?? 0,
      },
      transportTelemetry: {
        reconnectAttempts,
        state: liveTransport?.state ?? transportState,
        ready: liveTransport?.ready ?? transportReady,
        framesSent: Math.max(
          transportFramesSent,
          liveTransport?.framesSent ?? 0,
        ),
        framesDropped: liveTransport?.framesDropped ?? 0,
        diagnosticsCount: diagnosticsLog.length,
        recentMessageTypes: [...recentTransportMessageTypes],
        recentDiagnostics: [...diagnosticsLog.slice(-30)],
      },

      memoryGraph: memory
        ? {
            extractionCount: memory.extractionCount,
            injectedContext: memory.injectedContext,
            keyFactsCount: memory.record?.keyFacts?.length ?? 0,
            preferencesCount: memory.record?.preferences?.length ?? 0,
          }
        : null,
      affect,
    };
  };

  const handleSnapshot = (snapshot: OrchestratorSnapshot): void => {
    phase = projectPhase(snapshot.state);
    aiSpeaking = snapshot.state === "ASSISTANT_SPEAKING";
    if (snapshot.state === "RECOVERING" || snapshot.state === "RESUMING")
      reconnectAttempts += 1;
    if (snapshot.state === "FAILED") {
      recordDiagnostic({
        type: "voice.provider-error",
        reason: "voice-v3-failed",
      });
      if (!startupPending) notifySessionEnd("voice-v3-failed");
    }
    if (snapshot.state === "CLOSED") notifySessionEnd("voice-v3-closed");
    emitAudioState();
  };

  const handleEvent = (envelope: LayerLinkEnvelope<unknown>): void => {
    if (!active && !startupPending) return;
    if (envelope.messageType === "affect.state.updated") {
      emitAudioState();
      return;
    }

    if (envelope.messageType === "face.expression.updated") {
      emitAudioState();
      return;
    }

    if (envelope.messageType === "orchestrator.snapshot.updated") {
      handleSnapshot(envelope.payload as OrchestratorSnapshot);
      return;
    }

    if (envelope.messageType === "ORCHESTRATOR_FAILED") {
      const payload = asRecord(envelope.payload);
      recordDiagnostic({
        type: "voice.provider-error",
        reason: payload.reason || "voice-v3-failed",
      });
      return;
    }

    if (envelope.messageType === "caption.released") {
      const payload = asRecord(envelope.payload);
      const caption = asRecord(payload.caption);
      if (typeof caption.text === "string")
        callbacks.onCaption?.(caption.text, caption);
      return;
    }

    if (
      envelope.messageType === "ORCHESTRATOR_OUTPUT_TRANSCRIPT" ||
      envelope.messageType === "ORCHESTRATOR_TRANSCRIPT_EVENT"
    ) {
      const event = readVoiceEvent(envelope.payload);
      if (!event) return;
      if (event.type === "PROVIDER_INPUT_TRANSCRIPT") {
        if (micMuted) return;
        userTranscript = mergeTranscript(userTranscript, event.payload.text);
        turnHistory.push({
          speaker: "user",
          text: event.payload.text,
          timestamp: new Date().toISOString(),
        });
        callbacks.onTranscript?.("user", event.payload.text);
      } else if (event.type === "PROVIDER_OUTPUT_TRANSCRIPT") {
        aiTranscript = mergeTranscript(aiTranscript, event.payload.text);
        turnHistory.push({
          speaker: "ai",
          text: event.payload.text,
          timestamp: new Date().toISOString(),
        });
        callbacks.onTranscript?.("ai", event.payload.text);
      } else if (event.type === "PROVIDER_TURN_COMPLETE") {
        callbacks.onTurnComplete?.();
      } else if (event.type === "PROVIDER_INTERRUPTED") {
        interruptionsCount += 1;
        flushesCount += 1;
        recordDiagnostic({
          type: "voice.playback.flushed",
          reason: "provider-interrupted",
        });
      } else if (event.type === "PROVIDER_ERROR") {
        recordDiagnostic({
          type: "provider.error",
          error: event.payload.error,
        });
        if (!startupPending) notifySessionEnd("provider-error");
      }
      return;
    }

    if (envelope.messageType.startsWith("capture.")) {
      const payload = asRecord(envelope.payload);
      if (envelope.messageType === "capture.capture-error") {
        recordDiagnostic({
          type: "voice.capture-error",
          reason: payload.reason || "capture-error",
        });
      } else if (envelope.messageType === "capture.capture-started") {
        recordDiagnostic({ type: "voice.capture-started" });
      } else if (envelope.messageType === "capture.capture-stopped") {
        recordDiagnostic({ type: "voice.capture-stopped" });
      } else if (envelope.messageType === "capture.frame-deferred") {
        recordDiagnostic({
          type: "voice.input.deferred",
          reason: payload.reason || "transport-not-ready",
          sequence: numberOr(payload.sequence, 0),
        });
      }
      if (envelope.messageType !== "capture.metrics.updated") return;
    }

    if (envelope.messageType === "capture.metrics.updated") {
      const payload = asRecord(envelope.payload);
      framesCaptured = Math.max(
        framesCaptured,
        numberOr(payload.framesEmitted, 0),
      );
      lastRms = numberOr(payload.rms, 0);

      callbacks.onVolume?.({
        rms: lastRms,
        muted: Boolean(payload.muted),
        aiLevel: app?.playbackManager.getOutputLevel?.() ?? 0,
      });
      return;
    }

    if (envelope.messageType === "transport.snapshot.updated") {
      const snapshot = asRecord(envelope.payload);
      transportState =
        typeof snapshot.state === "string" ? snapshot.state : transportState;
      transportReady = Boolean(snapshot.ready);
      transportFramesSent = Math.max(
        transportFramesSent,
        numberOr(snapshot.framesSent, 0),
      );
      if (snapshot.state === "RECOVERING")
        recordDiagnostic({ type: "voice.socket-closed", code: "recovering" });
      return;
    }

    if (envelope.messageType === "transport.setup.complete") {
      transportReady = true;
      if (
        active &&
        !micMuted &&
        !userTranscript.trim() &&
        (framesCaptured === 0 || transportFramesSent === 0)
      )
        armInputWatchdog();
      return;
    }

    if (envelope.messageType.startsWith("transport.")) {
      const payload = asRecord(envelope.payload);
      if (envelope.messageType === "transport.message.received") {
        const messageType = typeof payload.messageType === "string" ? payload.messageType : "unknown";
        recentTransportMessageTypes = [...recentTransportMessageTypes, messageType].slice(-12);
      }
      const diagnosticType =
        envelope.messageType === "transport.socket.opened"
          ? "voice.socket-opened"
          : envelope.messageType === "transport.socket.closed"
            ? "voice.socket-closed"
            : envelope.messageType === "transport.socket.error"
              ? "voice.socket-error"
              : `voice.${envelope.messageType}`;
      recordDiagnostic({ type: diagnosticType, ...payload });
      return;
    }

    if (envelope.messageType.startsWith("playback.")) {
      const payload = asRecord(envelope.payload);
      if (envelope.messageType === "playback.chunk-scheduled")
        chunksScheduled += 1;
      if (envelope.messageType === "playback.flushed") flushesCount += 1;
      const diagnosticType =
        envelope.messageType === "playback.chunk-scheduled"
          ? "voice.playback.scheduled"
          : `voice.${envelope.messageType}`;
      recordDiagnostic({ type: diagnosticType, ...payload });
      return;
    }

    if (envelope.messageType === "ORCHESTRATOR_OPERATION_REQUESTED") {
      callbacks.onBackgroundTask?.({
        status: "started",
        name: "voice-operation",
      });
    }
  };

  return Object.freeze({
    async startSession(options: ProductionSessionOptions = {}): Promise<boolean> {
      if (stopInFlight) await stopInFlight;
      if (active) return false;
      callbacks = options;
      active = true;
      startupPending = true;
      sessionEndNotified = false;
      reconnectAttempts = 0;
      userTranscript = "";
      aiTranscript = "";
      sessionId = `voice-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      startTimeMs = Date.now();
      endTimeMs = 0;
      diagnosticsLog = [];
      turnHistory = [];
      chunksScheduled = 0;
      framesCaptured = 0;
      transportFramesSent = 0;
      transportReady = false;
      transportState = "IDLE";
      recentTransportMessageTypes = [];
      flushesCount = 0;
      interruptionsCount = 0;
      lastRms = 0;

      phase = "connecting";
      aiSpeaking = false;
      emitAudioState();

      const auth =
        options.getAuthToken ??
        (options.token ? async () => options.token ?? null : undefined);
      app = createVoiceV3App({
        providerMode: "real",
        productionMode: true,
        ...(auth === undefined ? {} : { getAuthToken: auth }),
        ...(options.getAppCheckToken === undefined ||
        options.getAppCheckToken === null
          ? {}
          : { getAppCheckToken: options.getAppCheckToken }),
        ...(options.refreshAuthToken === undefined ||
        options.refreshAuthToken === null
          ? {}
          : { refreshAuthToken: options.refreshAuthToken }),
        ...(options.refreshAppCheckToken === undefined ||
        options.refreshAppCheckToken === null
          ? {}
          : { refreshAppCheckToken: options.refreshAppCheckToken }),
        featureFlags: {
          ...DEFAULT_VOICE_V3_FEATURE_FLAGS,
          VOICE_V3_ENABLED: true,
        },
      });
      unsubscribe = app.bus.subscribe(handleEvent, {});
      try {
        await app.start({ startCapture: true });
        startupPending = false;
        armInputWatchdog();

        app.setMuted(micMuted);
        app.playbackManager.setSpeakerMuted(speakerMuted);
        phase = "listening";
        emitAudioState();
        recordDiagnostic({
          type: "voice.socket-open",
          setupSent: true,
          architecture: "voice-v3",
        });
        return true;
      } catch (error) {
        startupPending = false;
        clearInputWatchdog();
        active = false;

        unsubscribe?.();
        unsubscribe = null;
        app.dispose();
        app = null;
        phase = "idle";
        aiSpeaking = false;
        recordDiagnostic({ type: "provider.error", error });
        emitAudioState();
        throw error;
      }
    },

    async stopSession(): Promise<boolean> {
      if (stopInFlight) return stopInFlight;
      if (!active && !app) return false;
      startupPending = false;
      clearInputWatchdog();
      active = false;
      endTimeMs = Date.now();

      const sessionApp = app;
      const sessionUnsubscribe = unsubscribe;
      stopInFlight = (async () => {
        await sessionApp?.stop().catch(() => undefined);
        sessionUnsubscribe?.();
        if (unsubscribe === sessionUnsubscribe) unsubscribe = null;
        sessionApp?.dispose();
        if (app === sessionApp) app = null;
        phase = "idle";
        aiSpeaking = false;
        emitAudioState();
        return true;
      })().finally(() => {
        stopInFlight = null;
      });
      return stopInFlight;
    },

    setMuted(nextMuted: boolean): boolean {
      micMuted = Boolean(nextMuted);
      app?.setMuted(micMuted);
      emitAudioState();
      return micMuted;
    },

    setSpeakerMuted(nextMuted: boolean): boolean {
      speakerMuted = Boolean(nextMuted);
      app?.playbackManager.setSpeakerMuted?.(speakerMuted);
      return speakerMuted;
    },

    sendTextToModel(text: string): boolean {
      const normalized = text.trim();
      if (!normalized || !app?.transportManager.isReady) return false;
      return app.transportManager.sendRealtimeText(normalized);
    },

    injectAudioFrame(frame: AudioFrame): boolean {
      if (!active || !app) return false;
      return app.forwardCapturedFrame(frame);
    },

    endAudioStream(): boolean {
      if (!active || !app) return false;
      return app.endCapturedAudio();
    },

    setNativeCaptureSuppressed(suppressed: boolean): void {
      app?.setNativeCaptureSuppressed(suppressed);
    },

    getSessionState(): Record<string, unknown> {
      return {
        ...INITIAL_STATE,
        isActive: active,
        isMicMuted: micMuted,
        isAiSpeaking: aiSpeaking,
        isSpeakerMuted: speakerMuted,
        phase,
        reconnectAttempts,
        affect: app?.affectSnapshot ?? null,
        micAnalyser: null,
        aiAnalyser: null,
      };
    },

    getSessionDebugReport,
    getTranscriptSnapshot: () => ({ userTranscript, aiTranscript }),
    getMicMuted: () => micMuted,
    getAiSpeaking: () => aiSpeaking,
    getSpeakerMuted: () => speakerMuted,
  });
}

function projectPhase(state: OrchestratorSnapshot["state"]): string {
  if (
    [
      "CREDENTIAL_ACQUIRING",
      "PROVISIONING",
      "CONNECTING",
      "PROVIDER_READY",
      "GREETING_REQUESTED",
    ].includes(state)
  )
    return "connecting";
  if (["THINKING", "OPERATION_PENDING"].includes(state)) return "thinking";
  if (["RECOVERING", "RESUMING", "FALLBACK_ACTIVATING"].includes(state))
    return "recovering";
  if (["ASSISTANT_SPEAKING"].includes(state)) return "speaking";
  if (["CLOSING", "CLOSED", "FAILED", "IDLE"].includes(state)) return "idle";
  return "listening";
}

function mergeTranscript(previous: string, next: string): string {
  const prior = previous.trim();
  const current = next.trim();
  if (!current) return previous;
  if (!prior) return current;
  if (current === prior || current.startsWith(prior)) return current;
  if (prior.startsWith(current)) return prior;
  return /\s$/.test(previous)
    ? `${previous}${current}`
    : `${previous} ${current}`;
}

function readVoiceEvent(value: unknown): VoiceEvent | null {
  const payload = asRecord(value);
  if (
    typeof payload.type === "string" &&
    payload.type.startsWith("PROVIDER_")
  ) {
    return payload as unknown as VoiceEvent;
  }
  const event = asRecord(payload.event);
  return typeof event.type === "string" && event.type.startsWith("PROVIDER_")
    ? (event as unknown as VoiceEvent)
    : null;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, any>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

if (typeof window !== "undefined") {
  window.__MINDPAL_VOICE_RUNTIME__ = { createVoiceController };
}
