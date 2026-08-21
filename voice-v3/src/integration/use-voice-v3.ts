import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { createVoiceV3App, type VoiceProviderMode, type VoiceV3App } from "../app";
import { MockTokenProvider } from "../layers/transport/token-provider";
import type { LayerLinkEnvelope } from "../core/layer-link";
import type { OrchestratorSnapshot } from "../layers/orchestrator/orchestrator";
import type { CaptionPacerSnapshot } from "../layers/caption/pacer";
import type { TransportSnapshot } from "../layers/transport/ws-manager";
import { RealTokenProvider, type RealTokenProviderOptions } from "./real-token-provider";
import { TelemetrySink } from "./telemetry-sink";
import type { RealtimeTTSProviderOptions } from "../layers/backchannel/realtime-tts-provider";
import type { TtsEmotion } from "./tts-endpoint-contract";
import { evaluateVoiceV3Flags, type VoiceV3FeatureFlags } from "./feature-flags";

export type UseVoiceV3Options = {
  readonly providerMode?: VoiceProviderMode;
  readonly baseUrl?: string;
  readonly getAuthToken?: () => Promise<string | null>;
  readonly getAppCheckToken?: () => Promise<string | null>;
  readonly refreshAuthToken?: () => Promise<string | null>;
  readonly refreshAppCheckToken?: () => Promise<string | null>;
  readonly audioContextFactory?: () => AudioContext;
  readonly autoStart?: boolean;
  readonly startCapture?: boolean;
  readonly voicePersona?: string;
  readonly voiceEmotion?: TtsEmotion;
  readonly realtimeTtsOptions?: Omit<RealtimeTTSProviderOptions, "baseUrl" | "getAuthToken" | "getAppCheckToken">;
  readonly featureFlags?: VoiceV3FeatureFlags;
  readonly memoryUserId?: string;
  readonly incognito?: boolean;
  readonly flagContext?: Parameters<typeof evaluateVoiceV3Flags>[0];
};

export type VoiceV3HookState = {
  readonly orchestratorState: OrchestratorSnapshot | null;
  readonly activeCaption: string | null;
  readonly transportState: TransportSnapshot | null;
  readonly queueDepthMs: number;
  readonly isMuted: boolean;
  readonly isRunning: boolean;
  readonly errorMessage: string | null;
};

export type UseVoiceV3Result = VoiceV3HookState & {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly mute: () => void;
  readonly unmute: () => void;
};

type PendingPatch = Partial<VoiceV3HookState>;

const INITIAL_STATE: VoiceV3HookState = {
  orchestratorState: null,
  activeCaption: null,
  transportState: null,
  queueDepthMs: 0,
  isMuted: false,
  isRunning: false,
  errorMessage: null,
};

/**
 * React boundary for Voice V3. The app is created only inside an effect, so
 * render/SSR never touches MediaDevices, AudioContext, or WebSocket globals.
 */
export function useVoiceV3(options: UseVoiceV3Options = {}): UseVoiceV3Result {
  const appRef = useRef<VoiceV3App | null>(null);
  const mountedRef = useRef(false);
  const pendingRef = useRef<PendingPatch>({});
  const flushScheduledRef = useRef(false);
  const [state, setState] = useState<VoiceV3HookState>(INITIAL_STATE);

  const applyPatch = useCallback((patch: PendingPatch): void => {
    if (!mountedRef.current) return;
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    queueMicrotask(() => {
      flushScheduledRef.current = false;
      if (!mountedRef.current) return;
      const nextPatch = pendingRef.current;
      pendingRef.current = {};
      startTransition(() => {
        setState((current) => ({ ...current, ...nextPatch }));
      });
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    const providerMode = options.providerMode ?? "real";
    const featureFlags = options.featureFlags ?? evaluateVoiceV3Flags(options.flagContext);
    if (!featureFlags.VOICE_V3_ENABLED) {
      return () => {
        mountedRef.current = false;
      };
    }
    const tokenProvider = providerMode === "mock" ? new MockTokenProvider() : createTokenProvider(options);
    const appOptions = options.audioContextFactory === undefined
      ? {
          providerMode,
          productionMode: providerMode === "real",
          tokenProvider,
          featureFlags,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.getAuthToken === undefined ? {} : { getAuthToken: options.getAuthToken }),
          ...(options.getAppCheckToken === undefined ? {} : { getAppCheckToken: options.getAppCheckToken }),
          ...(options.voicePersona === undefined ? {} : { voicePersona: options.voicePersona }),
          ...(options.voiceEmotion === undefined ? {} : { voiceEmotion: options.voiceEmotion }),
          ...(options.realtimeTtsOptions === undefined ? {} : { realtimeTtsOptions: options.realtimeTtsOptions }),
          ...(options.memoryUserId === undefined ? {} : { memoryUserId: options.memoryUserId }),
          ...(options.incognito === undefined ? {} : { incognito: options.incognito }),
        }
      : {
          providerMode,
          productionMode: providerMode === "real",
          tokenProvider,
          featureFlags,
          audioContextFactory: options.audioContextFactory,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.getAuthToken === undefined ? {} : { getAuthToken: options.getAuthToken }),
          ...(options.getAppCheckToken === undefined ? {} : { getAppCheckToken: options.getAppCheckToken }),
          ...(options.voicePersona === undefined ? {} : { voicePersona: options.voicePersona }),
          ...(options.voiceEmotion === undefined ? {} : { voiceEmotion: options.voiceEmotion }),
          ...(options.realtimeTtsOptions === undefined ? {} : { realtimeTtsOptions: options.realtimeTtsOptions }),
          ...(options.memoryUserId === undefined ? {} : { memoryUserId: options.memoryUserId }),
          ...(options.incognito === undefined ? {} : { incognito: options.incognito }),
        };
    const app = createVoiceV3App(appOptions);
    appRef.current = app;

    const updateFromEnvelope = (envelope: LayerLinkEnvelope<unknown>): void => {
      if (disposed) return;
      if (envelope.messageType === "orchestrator.snapshot.updated") {
        const snapshot = envelope.payload as OrchestratorSnapshot;
        const recoveryMessage = snapshot.state === "FAILED"
          ? "Voice could not connect. Please check your connection and try again."
          : snapshot.state === "RECOVERING"
            ? "Connection lost, reconnecting…"
            : null;
        applyPatch({ orchestratorState: snapshot, errorMessage: recoveryMessage });
        return;
      }
      if (envelope.messageType === "caption.snapshot.updated") {
        const payload = envelope.payload as { readonly snapshot?: CaptionPacerSnapshot };
        if (payload.snapshot) {
          applyPatch({ activeCaption: payload.snapshot.lastReleasedCaption });
        }
        return;
      }
      if (envelope.messageType === "transport.snapshot.updated") {
        applyPatch({ transportState: envelope.payload as TransportSnapshot });
        return;
      }
      if (envelope.messageType === "playback.snapshot.updated") {
        const payload = envelope.payload as { readonly queueDepthMs?: unknown };
        if (typeof payload.queueDepthMs === "number") applyPatch({ queueDepthMs: payload.queueDepthMs });
        return;
      }
      if (envelope.messageType === "capture.metrics.updated") {
        const payload = envelope.payload as { readonly muted?: unknown };
        if (typeof payload.muted === "boolean") applyPatch({ isMuted: payload.muted });
      }
    };

    const unsubscribe = app.bus.subscribe(updateFromEnvelope, {});
    const telemetryOptions = {
      bus: app.bus,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.getAuthToken === undefined ? {} : { getAuthToken: options.getAuthToken }),
      ...(options.getAppCheckToken === undefined ? {} : { getAppCheckToken: options.getAppCheckToken }),
    };
    const telemetry = new TelemetrySink(telemetryOptions);
    applyPatch({
      orchestratorState: app.orchestrator.snapshot,
      transportState: app.transportManager.snapshot,
      queueDepthMs: app.playbackManager.snapshot.queueDepthMs,
    });

    if (options.autoStart) {
      void startApp(app, options.startCapture, applyPatch);
    }

    return () => {
      disposed = true;
      mountedRef.current = false;
      unsubscribe();
      pendingRef.current = {};
      void telemetry.close("react_unmount").catch(() => undefined);
      app.dispose();
      appRef.current = null;
    };
  }, [
    applyPatch,
    options.providerMode,
    options.baseUrl,
    options.getAuthToken,
    options.getAppCheckToken,
    options.refreshAuthToken,
    options.refreshAppCheckToken,
    options.audioContextFactory,
    options.autoStart,
    options.startCapture,
    options.voicePersona,
    options.voiceEmotion,
    options.realtimeTtsOptions,
    options.memoryUserId,
    options.incognito,
    options.featureFlags,
    options.flagContext,
  ]);

  const start = useCallback(async (): Promise<void> => {
    const app = appRef.current;
    if (!app) return;
    try {
      await app.start(options.startCapture === undefined ? {} : { startCapture: options.startCapture });
      applyPatch({ isRunning: true, errorMessage: null });
    } catch (error) {
      applyPatch({ isRunning: false, errorMessage: toRecoveryMessage(error) });
    }
  }, [applyPatch, options.startCapture]);

  const stop = useCallback(async (): Promise<void> => {
    const app = appRef.current;
    if (!app) return;
    try {
      await app.stop();
    } finally {
      applyPatch({ isRunning: false });
    }
  }, [applyPatch]);

  const mute = useCallback((): void => {
    appRef.current?.setMuted(true);
    applyPatch({ isMuted: true });
  }, [applyPatch]);

  const unmute = useCallback((): void => {
    appRef.current?.setMuted(false);
    applyPatch({ isMuted: false });
  }, [applyPatch]);

  return { ...state, start, stop, mute, unmute };
}

function createTokenProvider(options: UseVoiceV3Options): RealTokenProvider {
  const tokenOptions: RealTokenProviderOptions = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.getAuthToken === undefined ? {} : { getAuthToken: options.getAuthToken }),
    ...(options.getAppCheckToken === undefined ? {} : { getAppCheckToken: options.getAppCheckToken }),
    ...(options.refreshAuthToken === undefined ? {} : { refreshAuthToken: options.refreshAuthToken }),
    ...(options.refreshAppCheckToken === undefined ? {} : { refreshAppCheckToken: options.refreshAppCheckToken }),
  };
  return new RealTokenProvider(tokenOptions);
}

async function startApp(
  app: VoiceV3App,
  startCapture: boolean | undefined,
  applyPatch: (patch: PendingPatch) => void,
): Promise<void> {
  try {
    await app.start(startCapture === undefined ? {} : { startCapture });
    applyPatch({ isRunning: true, errorMessage: null });
  } catch (error) {
    applyPatch({ isRunning: false, errorMessage: toRecoveryMessage(error) });
  }
}

function toRecoveryMessage(error: unknown): string {
  if (isMicPermissionError(error)) return "Microphone permission denied.";
  if (error instanceof Error && error.message.includes("RECOVERING")) {
    return "Connection lost, reconnecting…";
  }
  return "Voice could not connect. Please check your connection and try again.";
}

function isMicPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly message?: unknown };
  return candidate.name === "NotAllowedError"
    || candidate.name === "PermissionDeniedError"
    || (typeof candidate.message === "string" && /microphone|permission denied/i.test(candidate.message));
}

