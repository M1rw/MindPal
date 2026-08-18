import { getLiveProviderCapabilities } from "./voice/provider_policy.js";
import { createGeminiLiveAdapter } from "./voice/provider/gemini_live_adapter.js";
import { buildGeminiLiveSetup } from "./voice/provider/gemini_setup_builder.js";
import { createBrowserAudioAdapter } from "./voice/capture/browser_audio_adapter.js";
import { createPlaybackManager } from "./voice/playback/playback_manager.js";
import { createLocalCueManager } from "./voice/playback/local_cue_manager.js";
import { createVoiceSessionOrchestrator } from "./voice/orchestrator/voice_session_orchestrator.js";
import { createBackchannelManager } from "./voice/backchannel/backchannel_manager.js";
import { createBackchannelProvider } from "./voice/backchannel/backchannel_provider.js";
import { createResponseStagingManager } from "./voice/staging/response_staging_manager.js";
import { createVoiceToolGateway } from "./voice/tools/tool_gateway.js";
import { createEvidenceGate } from "./voice/evidence/evidence_gate.js";
import { createRecoverySupervisor } from "./voice/transport/recovery_supervisor.js";
import { createVoiceSessionPersistence } from "./voice/lifecycle/session_persistence.js";
import { executeToolClientSide, createToolExecutor } from "./voice/tools.js";
import { verifyCurrentVoiceFact } from "./voice/fact_verifier.js";
import {
  buildEphemeralVoiceWebSocketUrl,
  fetchVoiceTokenWithRetry,
} from "./voice/startup_helpers.mjs";
import { VOICE_EVENTS } from "./voice/architecture/events.js";

function phaseProjection(phase, isAiSpeaking) {
  if (phase === "connecting") return { phase: "connecting", palette: "listen" };
  if (phase === "recovering") return { phase: "recovering", palette: "listen" };
  if (phase === "thinking" || phase === "tool-pending") return { phase: "thinking", palette: "listen" };
  if (phase === "user-interrupting-model") return { phase: "interrupting", palette: "listen" };
  if (isAiSpeaking || phase === "model-speaking") return { phase: "speaking", palette: "speak" };
  if (phase === "idle") return { phase: "idle", palette: "listen" };
  return { phase: "listening", palette: "listen" };
}

export function createVoiceSessionV2({
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  apiBaseUrl = () => globalThis.window?.MINDPAL_CONFIG?.API_BASE_URL || "",
  getAuthToken,
  refreshAuthToken,
  getAppCheckToken,
  refreshAppCheckToken,
  onTranscript = () => {},
  onAudioState = () => {},
  onSessionEnd = () => {},
  onTurnComplete = () => {},
  onBackgroundTask = () => {},
  onVolume = () => {},
  onDiagnostic = () => {},
} = {}) {
  let provider = null;
  let audio = null;
  let playback = null;
  let orchestrator = null;
  let recovery = null;
  let currentCredentials = null;
  let currentSetup = null;
  let contextProvider = null;
  let active = false;
  let lastUserTranscript = "";
  let lastAiTranscript = "";
  let sessionId = null;
  let speakerMuted = false;
  let credentialRefreshTimer = null;
  let preloadedCredentials = null;
  let localCueManager = null;

  function getToken() {
    return typeof getAuthToken === "function" ? getAuthToken() : getAuthToken;
  }

  function getAppToken() {
    return typeof getAppCheckToken === "function" ? getAppCheckToken() : getAppCheckToken;
  }

  function projectState(state) {
    const projection = phaseProjection(state.phase, state.isModelSpeaking);
    onAudioState({
      phase: projection.phase,
      palette: projection.palette,
      isAiSpeaking: state.isModelSpeaking,
      isMicMuted: audio?.isMuted?.() || false,
      reconnectAttempt: state.reconnectCount,
      interactionTag: state.isBackchannelPlaying ? "backchannel" : state.isThinkingCuePlaying ? "thinking-cue" : "",
    });
  }

  function handleEvent(event, state) {
    projectState(state);
    if (event.type === VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT) {
      lastUserTranscript = `${lastUserTranscript} ${event.text || ""}`.trim();
      onTranscript("user", event.text || "");
    } else if (event.type === VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT) {
      lastAiTranscript = `${lastAiTranscript} ${event.text || ""}`.trim();
      onTranscript("ai", event.text || "");
    } else if (event.type === VOICE_EVENTS.PROVIDER_TURN_COMPLETE) {
      onTurnComplete();
    } else if (event.type === VOICE_EVENTS.TOOL_STARTED) {
      onBackgroundTask({ status: "started", name: event.name });
    } else if ([VOICE_EVENTS.TOOL_RESOLVED, VOICE_EVENTS.TOOL_FAILED].includes(event.type)) {
      onBackgroundTask({ status: event.type === VOICE_EVENTS.TOOL_RESOLVED ? "ready" : "failed", name: event.name });
    } else if ([VOICE_EVENTS.PROVIDER_ERROR, VOICE_EVENTS.PROVIDER_CLOSED].includes(event.type)) {
      onDiagnostic(event);
    }
  }

  function clearCredentialRefreshTimer() {
    if (credentialRefreshTimer) clearTimeout(credentialRefreshTimer);
    credentialRefreshTimer = null;
  }

  function scheduleCredentialPrefetch() {
    clearCredentialRefreshTimer();
    const expiresAt = Date.parse(currentCredentials?.expires_at || "");
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(1_000, expiresAt - Date.now() - 5 * 60 * 1_000);
    credentialRefreshTimer = setTimeout(async () => {
      try {
        preloadedCredentials = await fetchVoiceTokenWithRetry({
          baseUrl: apiBaseUrl(),
          token: await getToken(),
          refreshToken: refreshAuthToken,
          appCheckToken: await getAppToken(),
          refreshAppCheckToken,
          fetchImpl,
        });
        onDiagnostic({ type: "voice.credentials-prefetched", expiresAt: preloadedCredentials.expires_at });
      } catch (error) {
        onDiagnostic({ type: "voice.credentials-prefetch-failed", error });
      }
    }, delay);
  }

  async function prepareTransport({ resumeHandle = null } = {}) {
    currentCredentials = preloadedCredentials || await fetchVoiceTokenWithRetry({
      baseUrl: apiBaseUrl(),
      token: await getToken(),
      refreshToken: refreshAuthToken,
      appCheckToken: await getAppToken(),
      refreshAppCheckToken,
      fetchImpl,
    });
    preloadedCredentials = null;
    scheduleCredentialPrefetch();
    const model = currentCredentials.model;
    currentSetup = buildGeminiLiveSetup({
      model,
      contextProvider,
      previousUserTranscript: lastUserTranscript,
      previousAiTranscript: lastAiTranscript,
      sessionResumptionHandle: resumeHandle || "",
    });
    return true;
  }

  async function connectTransport({ resumeHandle = null } = {}) {
    await prepareTransport({ resumeHandle });
    provider.updateContext?.({ sessionGeneration: orchestrator?.getState?.().sessionGeneration || 1 });
    provider.connect({
      url: buildEphemeralVoiceWebSocketUrl(currentCredentials),
      setup: currentSetup,
      identity: { sessionGeneration: orchestrator?.getState?.().sessionGeneration || 1, sessionId },
    });
    return true;
  }

  async function startSession({
    contextProvider: nextContextProvider = null,
    token = null,
    refreshAuthToken: nextRefreshAuthToken = null,
    getAppCheckToken: nextGetAppCheckToken = null,
    refreshAppCheckToken: nextRefreshAppCheckToken = null,
    incognito = false,
    onSessionEnd: nextOnSessionEnd = null,
    onTurnComplete: nextOnTurnComplete = null,
    onBackgroundTask: nextOnBackgroundTask = null,
    onVolume: nextOnVolume = null,
    onDiagnostic: nextOnDiagnostic = null,
    onTranscript: nextOnTranscript = null,
    onAudioState: nextOnAudioState = null,
  } = {}) {
    if (active) return false;
    if (nextOnSessionEnd) onSessionEnd = nextOnSessionEnd;
    if (nextOnTurnComplete) onTurnComplete = nextOnTurnComplete;
    if (nextOnBackgroundTask) onBackgroundTask = nextOnBackgroundTask;
    if (nextOnVolume) onVolume = nextOnVolume;
    if (nextOnDiagnostic) onDiagnostic = nextOnDiagnostic;
    if (nextOnTranscript) onTranscript = nextOnTranscript;
    if (nextOnAudioState) onAudioState = nextOnAudioState;
    contextProvider = nextContextProvider;
    if (token) getAuthToken = () => token;
    if (nextRefreshAuthToken) refreshAuthToken = nextRefreshAuthToken;
    if (nextGetAppCheckToken) getAppCheckToken = nextGetAppCheckToken;
    if (nextRefreshAppCheckToken) refreshAppCheckToken = nextRefreshAppCheckToken;
    sessionId = `voice-${Date.now().toString(36)}`;

    let providerEventHandler = null;
    provider = createGeminiLiveAdapter({
      WebSocketImpl,
      onEvent: (event) => providerEventHandler?.(event),
    });
    await prepareTransport();
    audio = await createBrowserAudioAdapter({
      onAudio: ({ base64Data, mimeType }) => provider?.sendAudio(base64Data, mimeType),
      onQuality: (quality) => orchestrator?.handleCaptureQuality(quality),
      onVolume,
    });
    playback = createPlaybackManager({ audioContext: audio.getAudioContext() });

    const model = currentCredentials.model;
    const capabilities = getLiveProviderCapabilities(model);
    const toolExecutor = createToolExecutor({
      getAuthToken: getToken,
      getAppCheckToken: getAppToken,
      contextProvider: () => contextProvider,
      apiBaseUrl,
    });
    const toolGateway = createVoiceToolGateway({
      localExecutor: async (name, args) => executeToolClientSide(name, args, contextProvider),
      backendExecutor: (name, args, options) => toolExecutor(name, args, options),
      evidenceExecutor: async (_name, args, options) => verifyCurrentVoiceFact({
        query: args.query,
        baseUrl: apiBaseUrl(),
        token: await getToken(),
        appCheckToken: await getAppToken(),
        fetchImpl,
        signal: options.signal,
      }),
      onEvent: (event) => handleEvent(event, orchestrator?.getState?.() || {}),
    });
    const evidenceGate = createEvidenceGate({
      verifier: async (query, options) => verifyCurrentVoiceFact({
        query,
        baseUrl: apiBaseUrl(),
        token: await getToken(),
        appCheckToken: await getAppToken(),
        fetchImpl,
        signal: options.signal,
      }),
      onEvent: (event) => handleEvent(event, orchestrator?.getState?.() || {}),
    });
    const backchannelManager = createBackchannelManager();
    const backchannelProvider = createBackchannelProvider({
      provider,
      capabilities: { sameSessionBackchannel: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_BACKCHANNEL === true && capabilities.proactiveAudio },
    });
    localCueManager = createLocalCueManager({
      audioUrls: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_CUE_AUDIO || {},
      allowSpeechSynthesis: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_LOCAL_CUES === true,
    });
    const responseStagingManager = createResponseStagingManager({
      onRequest: (request) => {
        const kind = request.cueIntent || "thinking";
        const local = localCueManager.play(kind, { language: request.language || "en-US" });
        if (!local.ok) void backchannelProvider.request({ kind: "attentive" });
      },
      onCancel: () => localCueManager.cancel("operation-cancelled"),
    });
    const persistence = createVoiceSessionPersistence({
      persist: async () => true,
    });
    recovery = createRecoverySupervisor({
      reconnect: async ({ resumeHandle }) => connectTransport({ resumeHandle }),
      reseed: async () => connectTransport(),
      onEvent: (event) => handleEvent(event, orchestrator?.getState?.() || {}),
    });
    orchestrator = createVoiceSessionOrchestrator({
      provider,
      capture: audio,
      playback,
      backchannelManager,
      responseStagingManager,
      toolGateway,
      evidenceGate,
      recoverySupervisor: recovery,
      persistence,
      onEvent: handleEvent,
    });
    providerEventHandler = (event) => orchestrator.handleProviderEvent(event);
    active = true;
    orchestrator.start({
      url: buildEphemeralVoiceWebSocketUrl(currentCredentials),
      setup: currentSetup,
      identity: { sessionId, incognito },
    });
    audio.start();
    return true;
  }

  async function stopSession() {
    if (!active) return false;
    active = false;
    orchestrator?.stop();
    await audio?.dispose?.();
    clearCredentialRefreshTimer();
    preloadedCredentials = null;
    provider = null;
    audio = null;
    playback = null;
    orchestrator = null;
    recovery = null;
    localCueManager?.cancel("session-stop");
    localCueManager = null;
    return true;
  }

  function setMuted(muted) {
    audio?.setMuted(muted);
  }

  function setSpeakerMuted(muted) {
    speakerMuted = Boolean(muted);
    playback?.setMuted(speakerMuted);
  }

  return Object.freeze({
    startSession,
    stopSession,
    setMuted,
    setSpeakerMuted,
    sendTextToModel: (text) => orchestrator?.sendText(text) || false,
    getSessionState: () => ({
      isActive: active,
      isMicMuted: audio?.isMuted?.() || false,
      isAiSpeaking: orchestrator?.getState?.().isModelSpeaking || false,
      isSpeakerMuted: speakerMuted,
      phase: orchestrator?.getState?.().phase || "idle",
      reconnectAttempts: orchestrator?.getState?.().reconnectCount || 0,
      micAnalyser: audio?.getMicAnalyser?.() || null,
      aiAnalyser: playback?.getOutputAnalyser?.() || null,
    }),
    getMicMuted: () => audio?.isMuted?.() || false,
    getAiSpeaking: () => orchestrator?.getState?.().isModelSpeaking || false,
    getSpeakerMuted: () => speakerMuted,
  });
}
