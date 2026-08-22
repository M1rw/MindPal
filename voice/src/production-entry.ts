import { createVoiceV3App, type VoiceV3App } from "./app";
import type { LayerLinkEnvelope } from "./core/layer-link";
import { DEFAULT_VOICE_V3_FEATURE_FLAGS } from "./integration/feature-flags";
import type { OrchestratorSnapshot } from "./layers/orchestrator/orchestrator";
import type { VoiceEvent } from "./layers/adapter/event-types";

type VoiceCallback = (...args: any[]) => void;

type ProductionSessionOptions = {
  readonly contextProvider?: unknown;
  readonly token?: string | null;
  readonly getAuthToken?: (() => Promise<string | null>) | null;
  readonly refreshAuthToken?: (() => Promise<string | null>) | null;
  readonly getAppCheckToken?: (() => Promise<string | null>) | null;
  readonly refreshAppCheckToken?: (() => Promise<string | null>) | null;
  readonly onTranscript?: (speaker: "user" | "ai", text: string) => void;
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
  getSessionState: () => Record<string, unknown>;
  getTranscriptSnapshot: () => { userTranscript: string; aiTranscript: string };
  getMicMuted: () => boolean;
  getAiSpeaking: () => boolean;
  getSpeakerMuted: () => boolean;
};

type RuntimeGlobal = {
  createVoiceController: () => ProductionController;
  createVoiceV3Controller: () => ProductionController;
};

declare global {
  interface Window {
    __MINDPAL_VOICE_RUNTIME__?: RuntimeGlobal;
    __MINDPAL_VOICE_V3_RUNTIME__?: RuntimeGlobal;
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

export function createVoiceV3Controller(): ProductionController {
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

  const emitAudioState = (): void => {
    const faceState = app?.faceLayer.processPhaseAndState(phase, aiSpeaking, micMuted);
    callbacks.onAudioState?.({
      phase,
      isAiSpeaking: aiSpeaking,
      isMicMuted: micMuted,
      palette: aiSpeaking ? "speak" : "listen",
      interactionTag: "",
      reconnectAttempts,
      faceExpression: faceState?.expression || "neutral",
      faceTheme: faceState?.theme || "geminiCore",
      faceState,
    });
  };

  const notifySessionEnd = (reason: string): void => {
    if (sessionEndNotified) return;
    sessionEndNotified = true;
    callbacks.onSessionEnd?.({ reason });
  };

  const handleSnapshot = (snapshot: OrchestratorSnapshot): void => {
    phase = projectPhase(snapshot.state);
    aiSpeaking = snapshot.state === "ASSISTANT_SPEAKING";
    if (snapshot.state === "RECOVERING" || snapshot.state === "RESUMING") reconnectAttempts += 1;
    if (snapshot.state === "FAILED") {
      callbacks.onDiagnostic?.({ type: "voice.provider-error", reason: "voice-v3-failed" });
      // During startup, let startSession() catch and surface the original
      // transport/capture error. Calling onSessionEnd here would run the UI
      // cleanup path first and hide the concrete failure behind a closed
      // overlay. Once startup has completed, FAILED is a real session end.
      if (!startupPending) notifySessionEnd("voice-v3-failed");
    }
    if (snapshot.state === "CLOSED") notifySessionEnd("voice-v3-closed");
    emitAudioState();
  };

  const handleEvent = (envelope: LayerLinkEnvelope<unknown>): void => {
    if (envelope.messageType === "face.expression.updated") {
      emitAudioState();
      return;
    }

    if (envelope.messageType === "orchestrator.snapshot.updated") {
      handleSnapshot(envelope.payload as OrchestratorSnapshot);
      return;
    }

    if (envelope.messageType === "ORCHESTRATOR_OUTPUT_TRANSCRIPT" || envelope.messageType === "ORCHESTRATOR_TRANSCRIPT_EVENT") {
      const event = readVoiceEvent(envelope.payload);
      if (!event) return;
      if (event.type === "PROVIDER_INPUT_TRANSCRIPT") {
        if (micMuted) return;
        userTranscript = mergeTranscript(userTranscript, event.payload.text);
        callbacks.onTranscript?.("user", event.payload.text);
      } else if (event.type === "PROVIDER_OUTPUT_TRANSCRIPT") {
        aiTranscript = mergeTranscript(aiTranscript, event.payload.text);
        callbacks.onTranscript?.("ai", event.payload.text);
      } else if (event.type === "PROVIDER_TURN_COMPLETE") {
        callbacks.onTurnComplete?.();
      } else if (event.type === "PROVIDER_INTERRUPTED") {
        callbacks.onDiagnostic?.({ type: "voice.playback.flushed", reason: "provider-interrupted" });
      } else if (event.type === "PROVIDER_ERROR") {
        callbacks.onDiagnostic?.({ type: "provider.error", error: event.payload.error });
        if (!startupPending) notifySessionEnd("provider-error");
      }
      return;
    }

    if (envelope.messageType === "capture.metrics.updated") {
      const payload = asRecord(envelope.payload);
      callbacks.onVolume?.({ rms: numberOr(payload.rms, 0), muted: Boolean(payload.muted) });
      return;
    }

    if (envelope.messageType === "transport.snapshot.updated") {
      const snapshot = asRecord(envelope.payload);
      if (snapshot.state === "RECOVERING") callbacks.onDiagnostic?.({ type: "voice.socket-closed", code: "recovering" });
      return;
    }

    if (envelope.messageType.startsWith("transport.")) {
      const payload = asRecord(envelope.payload);
      const diagnosticType = envelope.messageType === "transport.socket.opened"
        ? "voice.socket-opened"
        : envelope.messageType === "transport.socket.closed"
          ? "voice.socket-closed"
          : envelope.messageType === "transport.socket.error"
            ? "voice.socket-error"
            : `voice.${envelope.messageType}`;
      callbacks.onDiagnostic?.({ type: diagnosticType, ...payload });
      return;
    }

    if (envelope.messageType.startsWith("playback.")) {
      const payload = asRecord(envelope.payload);
      const diagnosticType = envelope.messageType === "playback.chunk-scheduled"
        ? "voice.playback.scheduled"
        : `voice.${envelope.messageType}`;
      callbacks.onDiagnostic?.({ type: diagnosticType, ...payload });
      return;
    }

    if (envelope.messageType === "ORCHESTRATOR_OPERATION_REQUESTED") {
      callbacks.onBackgroundTask?.({ status: "started", name: "voice-operation" });
    }
  };

  return Object.freeze({
    async startSession(options: ProductionSessionOptions = {}): Promise<boolean> {
      if (active) return false;
      callbacks = options;
      active = true;
      startupPending = true;
      sessionEndNotified = false;
      reconnectAttempts = 0;
      userTranscript = "";
      aiTranscript = "";
      phase = "connecting";
      aiSpeaking = false;
      emitAudioState();

      const auth = options.getAuthToken ?? (options.token ? async () => options.token ?? null : undefined);
      app = createVoiceV3App({
        providerMode: "real",
        productionMode: true,
        ...(auth === undefined ? {} : { getAuthToken: auth }),
        ...(options.getAppCheckToken === undefined || options.getAppCheckToken === null ? {} : { getAppCheckToken: options.getAppCheckToken }),
        ...(options.refreshAuthToken === undefined || options.refreshAuthToken === null ? {} : { refreshAuthToken: options.refreshAuthToken }),
        ...(options.refreshAppCheckToken === undefined || options.refreshAppCheckToken === null ? {} : { refreshAppCheckToken: options.refreshAppCheckToken }),
        featureFlags: { ...DEFAULT_VOICE_V3_FEATURE_FLAGS, VOICE_V3_ENABLED: true },
      });
      unsubscribe = app.bus.subscribe(handleEvent, {});
      try {
        await app.start({ startCapture: true });
        startupPending = false;
        app.setMuted(micMuted);
        app.playbackManager.setSpeakerMuted(speakerMuted);
        phase = "listening";
        emitAudioState();
        callbacks.onDiagnostic?.({ type: "voice.socket-open", setupSent: true, architecture: "voice-v3" });
        return true;
      } catch (error) {
        startupPending = false;
        active = false;
        unsubscribe?.();
        unsubscribe = null;
        app.dispose();
        app = null;
        phase = "idle";
        aiSpeaking = false;
        callbacks.onDiagnostic?.({ type: "provider.error", error });
        emitAudioState();
        throw error;
      }
    },

    async stopSession(): Promise<boolean> {
      if (!active) return false;
      startupPending = false;
      active = false;
      await app?.stop().catch(() => undefined);
      unsubscribe?.();
      unsubscribe = null;
      app?.dispose();
      app = null;
      phase = "idle";
      aiSpeaking = false;
      emitAudioState();
      return true;
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

    getSessionState(): Record<string, unknown> {
      return {
        ...INITIAL_STATE,
        isActive: active,
        isMicMuted: micMuted,
        isAiSpeaking: aiSpeaking,
        isSpeakerMuted: speakerMuted,
        phase,
        reconnectAttempts,
        micAnalyser: null,
        aiAnalyser: null,
      };
    },

    getTranscriptSnapshot: () => ({ userTranscript, aiTranscript }),
    getMicMuted: () => micMuted,
    getAiSpeaking: () => aiSpeaking,
    getSpeakerMuted: () => speakerMuted,
  });
}

function projectPhase(state: OrchestratorSnapshot["state"]): string {
  if (["CREDENTIAL_ACQUIRING", "PROVISIONING", "CONNECTING", "PROVIDER_READY", "GREETING_REQUESTED"].includes(state)) return "connecting";
  if (["THINKING", "OPERATION_PENDING"].includes(state)) return "thinking";
  if (["RECOVERING", "RESUMING", "FALLBACK_ACTIVATING"].includes(state)) return "recovering";
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
  return /\s$/.test(previous) ? `${previous}${current}` : `${previous} ${current}`;
}

function readVoiceEvent(value: unknown): VoiceEvent | null {
  const payload = asRecord(value);
  const event = asRecord(payload.event);
  return typeof event.type === "string" && event.type.startsWith("PROVIDER_") ? event as unknown as VoiceEvent : null;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? value as Record<string, any> : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const createVoiceController = createVoiceV3Controller;

if (typeof window !== "undefined") {
  const runtimeGlobal = { createVoiceController, createVoiceV3Controller };
  window.__MINDPAL_VOICE_RUNTIME__ = runtimeGlobal;
  window.__MINDPAL_VOICE_V3_RUNTIME__ = runtimeGlobal;
}
