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
import { createTranscriptAssembler } from "./voice/transcript_assembler.js";

function detectVoiceLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en-US";
}

export function buildDeliveryDiagnosticPayload(model, telemetry = {}, endReason = "client_stop") {
  const safeReason = String(endReason).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 40) || "client_stop";
  return {
    model: String(model || "").slice(0, 120),
    audio_parts: Number(telemetry.audioParts || 0),
    input_transcription_events: Number(telemetry.inputTranscriptionEvents || 0),
    output_transcription_events: Number(telemetry.outputTranscriptionEvents || 0),
    transcript_callback_events: Number(telemetry.transcriptCallbackEvents || 0),
    model_text_parts: Number(telemetry.modelTextParts || 0),
    turn_complete_events: Number(telemetry.turnCompleteEvents || 0),
    interrupted_events: Number(telemetry.interruptedEvents || 0),
    fact_gated_audio_parts: Number(telemetry.factGatedAudioParts || 0),
    end_reason: safeReason,
  };
}

function phaseProjection(phase = "idle", isAiSpeaking = false) {
  if (phase === "connecting") return { phase: "connecting", palette: "listen" };
  if (phase === "recovering") return { phase: "recovering", palette: "listen" };
  if (phase === "thinking" || phase === "tool-pending") return { phase: "thinking", palette: "listen" };
  if (phase === "user-interrupting-model") return { phase: "interrupting", palette: "listen" };
  if (isAiSpeaking || phase === "model-speaking") return { phase: "speaking", palette: "speak" };
  if (phase === "idle") return { phase: "idle", palette: "listen" };
  return { phase: "listening", palette: "listen" };
}

function createOutputAudioContext() {
  const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextImpl !== "function") return null;
  try {
    return new AudioContextImpl({ latencyHint: "interactive" });
  } catch {
    try { return new AudioContextImpl(); } catch { return null; }
  }
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
  let playbackAudioContext = null;
  let playback = null;
  let orchestrator = null;
  let recovery = null;
  let currentCredentials = null;
  let currentSetup = null;
  let contextProvider = null;
  let active = false;
  const userTranscriptAssembler = createTranscriptAssembler();
  const aiTranscriptAssembler = createTranscriptAssembler();
  let lastUserTranscript = "";
  let lastAiTranscript = "";
  let sessionId = null;
  let speakerMuted = false;
  let micMuted = false;
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
  let activePersistence = null;
  const pendingNativeCueRequests = new Map();
  let providerReadyGate = null;
  let sessionEndNotified = false;
  const deliveryTelemetry = {
    audioParts: 0,
    inputTranscriptionEvents: 0,
    outputTranscriptionEvents: 0,
    transcriptCallbackEvents: 0,
    modelTextParts: 0,
    turnCompleteEvents: 0,
    interruptedEvents: 0,
    factGatedAudioParts: 0,
  };

  function resetDeliveryTelemetry() {
    for (const key of Object.keys(deliveryTelemetry)) deliveryTelemetry[key] = 0;
  }

  async function reportDeliveryDiagnostic(endReason = "client_stop") {
    const baseUrl = apiBaseUrl();
    const model = currentCredentials?.model;
    if (!baseUrl || !model) return;
    const token = await Promise.resolve(getToken()).catch(() => null);
    const appCheckToken = await Promise.resolve(getAppToken()).catch(() => null);
    const payload = buildDeliveryDiagnosticPayload(model, deliveryTelemetry, endReason);
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
    await fetch(`${baseUrl}/voice/delivery-diagnostic`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      credentials: "omit",
      keepalive: true,
    }).catch(() => {});
  }

  function notifySessionEndOnce(reason = "transport-failure") {
    if (sessionEndNotified) return false;
    sessionEndNotified = true;
    try { onSessionEnd({ reason, sessionId }); } catch (error) { onDiagnostic({ type: "voice.session-end-callback-failed", error }); }
    return true;
  }

  function clearProviderReadyGate() {
    if (providerReadyGate?.timer) clearTimeout(providerReadyGate.timer);
    providerReadyGate = null;
  }

  function createProviderReadyGate(timeoutMs = 15_000) {
    clearProviderReadyGate();
    let resolveGate;
    let rejectGate;
    const promise = new Promise((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    const timer = setTimeout(() => {
      const gate = providerReadyGate;
      if (!gate) return;
      providerReadyGate = null;
      onDiagnostic({ type: "voice.provider-ready-timeout", timeoutMs });
      gate.reject(new Error("Voice connection timed out before Gemini setup completed."));
    }, timeoutMs);
    providerReadyGate = { resolve: resolveGate, reject: rejectGate, timer };
    return promise;
  }

  function settleProviderReady({ error = null } = {}) {
    const gate = providerReadyGate;
    if (!gate) return;
    clearProviderReadyGate();
    if (error) gate.reject(error instanceof Error ? error : new Error(String(error)));
    else gate.resolve(true);
  }

  function getToken() {
    return typeof getAuthToken === "function" ? getAuthToken() : getAuthToken;
  }

  function getAppToken() {
    return typeof getAppCheckToken === "function" ? getAppCheckToken() : getAppCheckToken;
  }

  function getOrchestratorState() {
    return orchestrator?.getState?.() || {};
  }

  function projectState(state = null) {
    const safeState = state || getOrchestratorState();
    const projection = phaseProjection(safeState.phase, safeState.isModelSpeaking);
    onAudioState({
      phase: projection.phase,
      palette: projection.palette,
      isAiSpeaking: Boolean(safeState.isModelSpeaking),
      isMicMuted: audio?.isMuted?.() || false,
      reconnectAttempt: safeState.reconnectCount || 0,
      interactionTag: safeState.isBackchannelPlaying ? "backchannel" : safeState.isThinkingCuePlaying ? "thinking-cue" : "",
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
    if (!/\b(?:mm[- ]?hm|yeah|go on|i hear you|sounds really hard|let me|give me a second|checking|look back|work that out|calculat|research|second)\b|(?:هممم|مممم|اهه|أيوه|حاضر|ثانية|لحظة|براجع|بشوف|هتحقق|هحسب|فاكر|فاكرة|نكمل|سامعك|حاسس بيك)/i.test(String(text || ""))) return false;
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
      sessionGeneration: getOrchestratorState().sessionGeneration || 0,
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
      language: detectVoiceLanguage(cleanText),
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
    if (event.type === "recovery.failed") notifySessionEndOnce("recovery-exhausted");
    if (event.type === VOICE_EVENTS.PROVIDER_READY) settleProviderReady();
    if (event.type === VOICE_EVENTS.PROVIDER_ERROR) settleProviderReady({ error: new Error("Gemini Live reported a provider error before setup completed.") });
    if (event.type === VOICE_EVENTS.PROVIDER_CLOSED && !getOrchestratorState().isReady) {
      settleProviderReady({ error: new Error(`Gemini Live closed before setup completed${event.code ? ` (code ${event.code})` : ""}.`) });
    }
    if (event.type === VOICE_EVENTS.PROVIDER_AUDIO) {
      deliveryTelemetry.audioParts += 1;
      observeNativeCueAudio();
    }
    if (event.type === VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT) {
      deliveryTelemetry.inputTranscriptionEvents += 1;
      deliveryTelemetry.transcriptCallbackEvents += 1;
      const eventKey = event.raw?.serverContent?.inputTranscription?.text
        ? `${event.identity?.sessionGeneration || 0}:input:${event.raw.serverContent.inputTranscription.text}:${event.finished ? "final" : "partial"}`
        : "";
      const assembled = userTranscriptAssembler.append(event.text || "", {
        mode: event.finished === true ? "snapshot" : "auto",
        eventKey,
      });
      currentUserTurnId = currentUserTurnId || `voice-turn-${Date.now().toString(36)}`;
      currentUserTurnText = assembled;
      lastUserTranscript = assembled;
      activePersistence?.update({ userTranscript: assembled });
      onTranscript("user", event.text || "");
      if (event.finished === true) void finalizeUserTurn({ turnId: currentUserTurnId, text: userTranscriptAssembler.finalize(event.text || "") });
    } else if (event.type === VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT) {
      deliveryTelemetry.outputTranscriptionEvents += 1;
      deliveryTelemetry.transcriptCallbackEvents += 1;
      if (event.fallback) deliveryTelemetry.modelTextParts += 1;
      observeNativeCueTranscript(event.text || "");
      const assembled = aiTranscriptAssembler.append(event.text || "", {
        mode: event.finished === true ? "snapshot" : "auto",
        eventKey: event.fallback ? "" : `${event.identity?.sessionGeneration || 0}:output:${event.text || ""}:${event.finished ? "final" : "partial"}`,
      });
      lastAiTranscript = assembled;
      activePersistence?.update({ aiTranscript: assembled });
      onTranscript("ai", event.text || "");
        } else if (event.type === VOICE_EVENTS.PROVIDER_TURN_COMPLETE) {
      deliveryTelemetry.turnCompleteEvents += 1;
      if (currentUserTurnText) void finalizeUserTurn({ turnId: currentUserTurnId, text: userTranscriptAssembler.finalize(currentUserTurnText) });
      userTranscriptAssembler.reset();
      activePersistence?.update({ completedTurnCount: (activePersistence.getActive?.()?.completedTurnCount || 0) + 1 });
      onTurnComplete();
    } else if (event.type === VOICE_EVENTS.TOOL_STARTED) {
      // Tool execution alone is not a spoken thinking cue. The UI status is
      // promoted only after native Gemini cue audio is confirmed.
      if (!event.identity?.operationId) onBackgroundTask({ status: "started", name: event.name });
    } else if ([VOICE_EVENTS.TOOL_RESOLVED, VOICE_EVENTS.TOOL_FAILED].includes(event.type)) {
      onBackgroundTask({ status: event.type === VOICE_EVENTS.TOOL_RESOLVED ? "ready" : "failed", name: event.name });
    } else if (event.type === VOICE_EVENTS.PROVIDER_INTERRUPTED) {
      deliveryTelemetry.interruptedEvents += 1;
      cancelActiveOperation("user-interrupted");
    } else if ([VOICE_EVENTS.PROVIDER_ERROR, VOICE_EVENTS.PROVIDER_CLOSED].includes(event.type)) {
      onDiagnostic(event);
      if (event.type === VOICE_EVENTS.PROVIDER_ERROR && !recovery) notifySessionEndOnce("provider-error");
      if (event.type === VOICE_EVENTS.PROVIDER_CLOSED && !recovery) notifySessionEndOnce("provider-closed");
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
    const readyPromise = createProviderReadyGate();
    provider.updateContext?.({ sessionGeneration: getOrchestratorState().sessionGeneration || 1 });
    provider.connect({
      url: buildEphemeralVoiceWebSocketUrl(currentCredentials),
      setup: currentSetup,
      identity: { sessionGeneration: getOrchestratorState().sessionGeneration || 1, sessionId },
    });
    await readyPromise;
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
    sessionEndNotified = false;
    resetDeliveryTelemetry();
    playbackAudioContext = createOutputAudioContext();
    if (playbackAudioContext?.state === "suspended") {
      await playbackAudioContext.resume().catch(() => {});
    }

    let providerEventHandler = null;
    provider = createGeminiLiveAdapter({
      WebSocketImpl,
      onEvent: (event) => providerEventHandler?.(event),
      onDiagnostic,
    });
    await prepareTransport();
    audio = await createBrowserAudioAdapter({
      onAudio: ({ base64Data, mimeType }) => {
        // Capture already suppresses muted frames; this second boundary protects
        // against worklet frames that were queued immediately before the toggle.
        if (!micMuted) provider?.sendAudio(base64Data, mimeType);
      },
      onQuality: (quality) => orchestrator?.handleCaptureQuality(quality),
      onVolume,
    });
    audio.setMuted(micMuted);
    playback = createPlaybackManager({
      audioContext: playbackAudioContext || audio.getAudioContext(),
      outputSampleRate: 24_000,
    });
    onDiagnostic({
      type: "voice.audio-output-ready",
      contextSampleRate: playbackAudioContext?.sampleRate || audio.getAudioContext()?.sampleRate || null,
      outputSampleRate: 24_000,
      separateContext: Boolean(playbackAudioContext),
    });

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
      onEvent: (event) => handleEvent(event, getOrchestratorState()),
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
      onEvent: (event) => handleEvent(event, getOrchestratorState()),
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
        void backchannelProvider.request({ kind: request.kind, language: request.context?.language || detectVoiceLanguage(currentUserTurnText) }).then((result) => {
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
        void backchannelProvider.request({ kind, language: request.language || detectVoiceLanguage(currentUserTurnText) }).then((result) => {
          if (result?.ok) armNativeCueConfirmation({ key: `staging:${request.operationId}`, kind: "staging", operationId: request.operationId, request });
        });
      },
      onCancel: () => localCueManager.cancel("operation-cancelled"),
    });
    const persistence = createVoiceSessionPersistence({
      persist: async (record) => {
        if (record.incognito || typeof globalThis.localStorage === "undefined") return true;
        const key = "mindpal.voice.sessions.v2";
        try {
          const existing = JSON.parse(globalThis.localStorage.getItem(key) || "[]");
          const sessions = Array.isArray(existing) ? existing : [];
          sessions.push(record);
          globalThis.localStorage.setItem(key, JSON.stringify(sessions.slice(-20)));
        } catch (error) {
          onDiagnostic({ type: "voice.session-persistence-failed", error });
          throw error;
        }
        return true;
      },
    });
    activePersistence = persistence;
    activeResponseStagingManager = responseStagingManager;
    activeBackchannelManager = backchannelManager;
    recovery = createRecoverySupervisor({
      reconnect: async ({ resumeHandle }) => connectTransport({ resumeHandle }),
      reseed: async () => connectTransport(),
      onEvent: (event) => handleEvent(event, getOrchestratorState()),
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
      onEvent: (event) => handleEvent(event, getOrchestratorState()),
    });
    providerEventHandler = (event) => orchestrator.handleProviderEvent(event);
    active = true;
    const providerReadyPromise = createProviderReadyGate();
    orchestrator.start({
      url: buildEphemeralVoiceWebSocketUrl(currentCredentials),
      setup: currentSetup,
      identity: { sessionId, incognito },
    });
    audio.start();
    await providerReadyPromise;
    return true;
  }

  async function stopSession() {
    if (!active) return false;
    active = false;
    sessionEndNotified = true;
    reportDeliveryDiagnostic("client_stop");
    settleProviderReady({ error: new Error("Voice session stopped before Gemini setup completed.") });
    orchestrator?.stop();
    playback?.flush?.({ reason: "session-stop" });
    await audio?.dispose?.();
    if (playbackAudioContext && playbackAudioContext !== audio?.getAudioContext?.()) {
      await playbackAudioContext.close?.().catch(() => {});
    }
    clearCredentialRefreshTimer();
    preloadedCredentials = null;
    provider = null;
    audio = null;
    playbackAudioContext = null;
    playback = null;
    orchestrator = null;
    recovery = null;
    cancelActiveOperation("session-stop");
    cancelPendingNativeCues("session-stop");
    operationsByTurn.clear();
    finalizedTurnIds.clear();
    userTranscriptAssembler.reset();
    aiTranscriptAssembler.reset();
    lastUserTranscript = "";
    lastAiTranscript = "";
    activeOperationTurnId = null;
    activeToolGateway = null;
    activeEvidenceGate = null;
    activeResponseStagingManager = null;
    activePersistence = null;
    micMuted = false;
    localCueManager?.cancel("session-stop");
    localCueManager = null;
    return true;
  }

  function setMuted(muted) {
    micMuted = Boolean(muted);
    audio?.setMuted(micMuted);
    projectState();
    return micMuted;
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
    getSessionState: () => {
      const state = getOrchestratorState();
      return {
        isActive: active,
        isMicMuted: micMuted,
        isAiSpeaking: Boolean(state.isModelSpeaking),
        isSpeakerMuted: speakerMuted,
        phase: state.phase || "idle",
        reconnectAttempts: state.reconnectCount || 0,
        micAnalyser: audio?.getMicAnalyser?.() || null,
        aiAnalyser: playback?.getOutputAnalyser?.() || null,
      };
    },
    getMicMuted: () => micMuted,
    getAiSpeaking: () => Boolean(getOrchestratorState().isModelSpeaking),
    getSpeakerMuted: () => speakerMuted,
    getTranscriptSnapshot: () => ({
      userTranscript: userTranscriptAssembler.getText() || lastUserTranscript,
      aiTranscript: aiTranscriptAssembler.getText() || lastAiTranscript,
    }),
  });
}
