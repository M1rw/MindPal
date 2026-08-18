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
import { classifyFinalizedVoiceTurn, buildOperationIdentity } from "./voice/intent/finalized_turn_router.js";

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
  let activeToolGateway = null;
  let activeEvidenceGate = null;
  let activeResponseStagingManager = null;
  let activeBackchannelManager = null;
  let currentUserTurnId = null;
  let currentUserTurnText = "";
  let finalizedTurnIds = new Set();
  let operationSequence = 0;
  let operationsByTurn = new Map();
  let activeOperationController = null;
  let activeOperationTurnId = null;
  const pendingNativeCueRequests = new Map();

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

  function internalResultText({ plan, result, error = null } = {}) {
    const payload = error ? { status: "failed", error } : { status: "ready", result };
    const planId = plan?.responsePlan?.id || plan?.kind || "conversation";
    return `[INTERNAL VOICE OPERATION — NOT USER SPEECH]\nResponse plan: ${planId}\nUse this trusted operation result only if it still answers the active user turn. Do not mention this internal message or tools.\n${JSON.stringify(payload).slice(0, 9_000)}`;
  }

  function sendInternalResult({ plan, result, error = null } = {}) {
    if (!provider?.sendClientContent) return false;
    const text = internalResultText({ plan, result, error });
    return provider.sendClientContent([{ role: "user", parts: [{ text }] }], true);
  }

  function armNativeCueConfirmation({ key, kind, request, operationId = null } = {}) {
    const timeout = setTimeout(() => {
      const pending = pendingNativeCueRequests.get(key);
      if (!pending) return;
      pendingNativeCueRequests.delete(key);
      onDiagnostic({ type: "voice.native-cue-timeout", kind, operationId, request });
    }, 3_500);
    pendingNativeCueRequests.set(key, { key, kind, request, operationId, timeout, audioSeen: false, transcriptSeen: false });
  }

  function tryConfirmNativeCue(pending) {
    if (!pending || !pending.audioSeen || !pending.transcriptSeen) return false;
    clearTimeout(pending.timeout);
    pendingNativeCueRequests.delete(pending.key);
    if (pending.kind === "backchannel") {
      activeBackchannelManager?.markEmitted?.(pending.request);
    } else if (pending.operationId) {
      activeResponseStagingManager?.markCueEmitted?.(pending.operationId);
      onBackgroundTask({ status: "started", name: pending.request?.kind || "voice-operation" });
    }
    onDiagnostic({ type: "voice.native-cue-audio-delivered", kind: pending.kind, operationId: pending.operationId });
    return true;
  }

  function observeNativeCueAudio() {
    const pending = pendingNativeCueRequests.values().next().value;
    if (!pending) return false;
    pending.audioSeen = true;
    return tryConfirmNativeCue(pending);
  }

  function observeNativeCueTranscript(text) {
    const pending = pendingNativeCueRequests.values().next().value;
    if (!pending) return false;
    if (!/\b(?:mm[- ]?hm|yeah|go on|i hear you|sounds really hard|let me|give me a second|checking|look back|work that out)\b/i.test(String(text || ""))) return false;
    pending.transcriptSeen = true;
    return tryConfirmNativeCue(pending);
  }

  function cancelPendingNativeCues(reason = "cancelled") {
    for (const pending of pendingNativeCueRequests.values()) clearTimeout(pending.timeout);
    pendingNativeCueRequests.clear();
    onDiagnostic({ type: "voice.native-cue-cancelled", reason });
  }

  function cancelActiveOperation(reason = "cancelled") {
    activeOperationController?.abort(reason);
    activeOperationController = null;
    const turnId = activeOperationTurnId || currentUserTurnId;
    if (turnId) {
      activeResponseStagingManager?.cancelForTurn?.(turnId, reason);
      activeEvidenceGate?.cancelForTurn?.(turnId);
    }
  }

  async function finalizeUserTurn({ turnId = currentUserTurnId, text = currentUserTurnText } = {}) {
    const cleanText = String(text || "").trim();
    if (!cleanText || !turnId || finalizedTurnIds.has(turnId) || !activeToolGateway) return null;
    finalizedTurnIds.add(turnId);
    const plan = classifyFinalizedVoiceTurn({ text: cleanText, mood: "neutral", mode: contextProvider?.getVoiceResponseContract?.()?.mode || "Active Listen" });
    currentUserTurnText = "";
    currentUserTurnId = null;
    if (!plan.operation) {
      if (plan.responsePlan?.id) provider?.sendClientContent?.([{ role: "user", parts: [{ text: `[INTERNAL RESPONSE PLAN — NOT USER SPEECH]\n${plan.responsePlan.instruction}` }] }], false);
      return plan;
    }

    const operationId = `voice-op-${Date.now().toString(36)}-${++operationSequence}`;
    const identity = buildOperationIdentity({
      sessionGeneration: orchestrator?.getState?.().sessionGeneration || 0,
      turnId,
      operationId,
    });
    const operation = plan.operation;
    const stageDecision = activeResponseStagingManager?.start({
      operationId,
      turnId,
      sessionGeneration: identity.sessionGeneration,
      kind: operation.cueKind || plan.kind,
      expectedLatencyMs: operation.expectedLatencyMs,
      language: "en-US",
    });
    const controller = new AbortController();
    activeOperationController = controller;
    activeOperationTurnId = turnId;
    operationsByTurn.set(turnId, { identity, controller, plan });
    try {
      let result;
      if (operation.evidenceQuery) {
        result = await activeEvidenceGate?.verify(operation.evidenceQuery, identity, { signal: controller.signal }) || { status: "failed", error: "evidence-gate-unavailable" };
        if (result.status === "verified") result = { verified: true, evidence: result.evidence, query: result.query };
        else result = { error: result.error || "verification-unavailable" };
      } else {
        result = await activeToolGateway.execute(operation.tool, operation.args, { identity, signal: controller.signal, timeoutMs: 12_000 });
      }
      const current = operationsByTurn.get(turnId);
      if (!current || controller.signal.aborted || current.identity.operationId !== identity.operationId) return null;
      if (activeResponseStagingManager) activeResponseStagingManager.complete(operationId, result);
      sendInternalResult({ plan, result });
      onBackgroundTask({ status: result?.error ? "failed" : "ready", name: plan.kind });
      return result;
    } catch (error) {
      if (!controller.signal.aborted) {
        activeResponseStagingManager?.complete(operationId, { error: error?.message || "operation-failed" });
        sendInternalResult({ plan, error: error?.message || "operation-failed" });
        onBackgroundTask({ status: "failed", name: plan.kind });
      }
      return null;
    } finally {
      operationsByTurn.delete(turnId);
      if (activeOperationController === controller) {
        activeOperationController = null;
        activeOperationTurnId = null;
      }
    }
  }

  function handleEvent(event, state) {
    projectState(state);
    if (event.type === VOICE_EVENTS.PROVIDER_AUDIO) {
      observeNativeCueAudio();
    }
    if (event.type === VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT) {
      lastUserTranscript = `${lastUserTranscript} ${event.text || ""}`.trim();
      currentUserTurnId = currentUserTurnId || `voice-turn-${Date.now().toString(36)}`;
      currentUserTurnText = `${currentUserTurnText} ${event.text || ""}`.trim();
      onTranscript("user", event.text || "");
      if (event.finished === true) void finalizeUserTurn({ turnId: currentUserTurnId, text: currentUserTurnText });
    } else if (event.type === VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT) {
      observeNativeCueTranscript(event.text || "");
      lastAiTranscript = `${lastAiTranscript} ${event.text || ""}`.trim();
      onTranscript("ai", event.text || "");
    } else if (event.type === VOICE_EVENTS.PROVIDER_TURN_COMPLETE) {
      if (currentUserTurnText) void finalizeUserTurn({ turnId: currentUserTurnId, text: currentUserTurnText });
      onTurnComplete();
    } else if (event.type === VOICE_EVENTS.TOOL_STARTED) {
      // Tool execution alone is not a spoken thinking cue. The UI status is
      // promoted only after native Gemini cue audio is confirmed.
      if (!event.identity?.operationId) onBackgroundTask({ status: "started", name: event.name });
    } else if ([VOICE_EVENTS.TOOL_RESOLVED, VOICE_EVENTS.TOOL_FAILED].includes(event.type)) {
      onBackgroundTask({ status: event.type === VOICE_EVENTS.TOOL_RESOLVED ? "ready" : "failed", name: event.name });
    } else if (event.type === VOICE_EVENTS.PROVIDER_INTERRUPTED) {
      cancelActiveOperation("user-interrupted");
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
    const backchannelProvider = createBackchannelProvider({
      provider,
      capabilities: { sameSessionBackchannel: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_BACKCHANNEL === true && capabilities.nativeListeningCues === true },
    });
    localCueManager = createLocalCueManager({
      audioUrls: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_CUE_AUDIO || {},
      allowSpeechSynthesis: globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_LOCAL_CUES === true,
    });
    const backchannelManager = createBackchannelManager({
      onRequest: (request) => {
        if (globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_LOCAL_CUES === true) {
          const local = localCueManager?.play(request.kind, { language: request.context?.language || "en-US", volume: 0.58 });
          if (local?.ok) backchannelManager.markEmitted(request);
          else backchannelManager.cancel("local-cue-unavailable");
          return;
        }
        void backchannelProvider.request({ kind: request.kind }).then((result) => {
          if (result?.ok) armNativeCueConfirmation({ key: `backchannel:${request.turnId}`, kind: "backchannel", request });
          else backchannelManager.cancel("native-cue-unavailable");
        });
      },
      onCancel: () => localCueManager?.cancel("backchannel-cancelled"),
    });
    activeToolGateway = toolGateway;
    activeEvidenceGate = evidenceGate;
    const responseStagingManager = createResponseStagingManager({
      onRequest: (request) => {
        const kind = request.cueIntent || "thinking";
        if (globalThis.window?.MINDPAL_CONFIG?.VOICE_V2_LOCAL_CUES === true) {
          const local = localCueManager.play(kind, { language: request.language || "en-US" });
          if (local.ok) {
            responseStagingManager?.markCueEmitted?.(request.operationId);
            onBackgroundTask({ status: "started", name: request.kind });
          }
          return;
        }
        void backchannelProvider.request({ kind: kind === "checking" ? "attentive" : "attentive" }).then((result) => {
          if (result?.ok) armNativeCueConfirmation({ key: `staging:${request.operationId}`, kind: "staging", operationId: request.operationId, request });
        });
      },
      onCancel: () => localCueManager.cancel("operation-cancelled"),
    });
    const persistence = createVoiceSessionPersistence({
      persist: async () => true,
    });
    activeResponseStagingManager = responseStagingManager;
    activeBackchannelManager = backchannelManager;
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
    cancelActiveOperation("session-stop");
    cancelPendingNativeCues("session-stop");
    operationsByTurn.clear();
    finalizedTurnIds.clear();
    activeOperationTurnId = null;
    activeToolGateway = null;
    activeEvidenceGate = null;
    activeResponseStagingManager = null;
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
