import {
  createVoiceIdentityFactory,
  createArtifactIdentity,
} from "../architecture/ids.js";
import {
  VOICE_EVENTS,
  createVoiceEvent,
} from "../architecture/events.js";
import {
  VOICE_ACTIONS,
  createInitialVoiceState,
  voiceStateReducer,
} from "../architecture/state.js";
import { getToolResponseScheduling } from "../provider_policy.js";

export function createVoiceSessionOrchestrator({
  provider,
  capture,
  playback,
  now = () => Date.now(),
  identityFactory = createVoiceIdentityFactory({ now }),
  backchannelManager = null,
  responseStagingManager = null,
  toolGateway = null,
  evidenceGate = null,
  recoverySupervisor = null,
  persistence = null,
  onEvent = () => {},
  onDiagnostic = () => {},
} = {}) {
  if (!provider || typeof provider.connect !== "function") throw new TypeError("provider adapter is required");
  if (!capture || typeof capture.start !== "function") throw new TypeError("capture adapter is required");
  if (!playback || typeof playback.schedule !== "function") throw new TypeError("playback manager is required");

  let state = createInitialVoiceState({ now });
  let listeners = new Set();
  let started = false;
  let localBargeInPending = false;
  let noiseFloorRms = 0.0025;
  let latestResumeHandle = "";
  let activeTurnStartedAt = 0;
  let providerResponseClosed = false;
  const pendingToolResults = [];

  function emit(event) {
    onEvent(event);
    for (const listener of listeners) listener(event, state);
  }

  function dispatch(action) {
    const previous = state;
    state = voiceStateReducer(state, action, { now });
    if (state !== previous) emit(createVoiceEvent(VOICE_EVENTS.CAPTURE_STATE, { action, state }));
    return state;
  }

  function currentIdentity({ playbackGeneration = state.playbackGeneration } = {}) {
    return createArtifactIdentity({
      sessionGeneration: state.sessionGeneration,
      turnId: state.activeTurnId,
      providerResponseId: state.activeProviderResponseId,
      playbackGeneration,
    });
  }

  function ensureTurn() {
    if (state.activeTurnId) return state.activeTurnId;
    const turnId = identityFactory.nextTurnId();
    activeTurnStartedAt = now();
    dispatch({
      type: VOICE_ACTIONS.CAPTURE_SPEECH_STARTED,
      sessionGeneration: state.sessionGeneration,
      turnId,
    });
    return turnId;
  }

  function handleCaptureQuality(quality = {}) {
    if (!started || !state.isModelSpeaking || state.isMicMuted) return false;
    const rms = Number(quality.rms) || 0;
    const observedNoise = Number(quality.noiseFloorRms);
    if (Number.isFinite(observedNoise) && observedNoise > 0) noiseFloorRms = Math.min(noiseFloorRms * 0.98 + observedNoise * 0.02, 0.08);
    const startThreshold = Math.max(0.018, noiseFloorRms * 4.5);
    const releaseThreshold = Math.max(0.009, startThreshold * 0.55);
    if (!localBargeInPending && rms >= startThreshold) {
      localBargeInPending = true;
      playback.setOptimisticDucked?.(true);
      dispatch({ type: VOICE_ACTIONS.LOCAL_BARGE_IN_PENDING, sessionGeneration: state.sessionGeneration });
      emit(createVoiceEvent(VOICE_EVENTS.CAPTURE_STATE, { reason: "optimistic-barge-in", rms, threshold: startThreshold }));
      return true;
    }
    if (localBargeInPending && rms <= releaseThreshold) {
      localBargeInPending = false;
      playback.setOptimisticDucked?.(false);
      dispatch({ type: VOICE_ACTIONS.LOCAL_BARGE_IN_RELEASED, sessionGeneration: state.sessionGeneration });
      return true;
    }
    return localBargeInPending;
  }

  function flushPendingToolResults() {
    if (!pendingToolResults.length) return 0;
    const ready = pendingToolResults.splice(0, pendingToolResults.length);
    if (provider.sendToolResponse) provider.sendToolResponse(ready.map((item) => item.response));
    for (const item of ready) emit(createVoiceEvent(item.result?.error ? VOICE_EVENTS.TOOL_FAILED : VOICE_EVENTS.TOOL_RESOLVED, {
      identity: item.identity,
      result: item.result,
      scheduling: item.scheduling,
      releasedAt: now(),
    }));
    return ready.length;
  }

  function beginRecovery(reason, event = {}) {
    if (!started || !recoverySupervisor) return false;
    dispatch({ type: VOICE_ACTIONS.RECOVERY_STARTED, sessionGeneration: state.sessionGeneration });
    void recoverySupervisor.recover({
      reason,
      resumeHandle: event.resumeHandle || latestResumeHandle || null,
      continuity: { turnId: state.activeTurnId, providerResponseId: state.activeProviderResponseId },
    }).then((result) => {
      if (result.ok) dispatch({ type: VOICE_ACTIONS.RECOVERY_READY, sessionGeneration: state.sessionGeneration });
      else dispatch({ type: VOICE_ACTIONS.RECOVERY_FAILED, sessionGeneration: state.sessionGeneration, error: result.error });
    }).catch((error) => {
      dispatch({ type: VOICE_ACTIONS.RECOVERY_FAILED, sessionGeneration: state.sessionGeneration, error: error?.message || "voice-recovery-failed" });
    });
    return true;
  }

  function handleProviderEvent(event) {
    if (!event || !event.type) return;
    switch (event.type) {
      case VOICE_EVENTS.PROVIDER_READY:
        providerResponseClosed = false;
        dispatch({ type: VOICE_ACTIONS.SESSION_READY, sessionGeneration: state.sessionGeneration });
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT: {
        providerResponseClosed = false;
        const turnId = ensureTurn();
        dispatch({
          type: VOICE_ACTIONS.INPUT_TRANSCRIPT_UPDATED,
          sessionGeneration: state.sessionGeneration,
          turnId,
          text: event.text,
        });
        if (backchannelManager && event.finished !== true) {
          backchannelManager.consider({
            sessionGeneration: state.sessionGeneration,
            turnId,
            speechDurationMs: event.speechDurationMs || Math.max(0, now() - activeTurnStartedAt),
            pauseDurationMs: event.pauseDurationMs || 0,
            transcriptConfidence: event.transcriptConfidence ?? 1,
            topic: event.topic || "story",
            emotion: event.emotion || "neutral",
        userHasYielded: false,
        isModelSpeaking: state.isModelSpeaking,
        safetyGate: event.safetyGate || "none",
          });
        }
        emit(Object.freeze({ ...event, turnId }));
        return;
      }
      case VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT:
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_AUDIO: {
        if (providerResponseClosed && !backchannelManager?.hasPending?.()) {
          onDiagnostic({ type: "voice.stale-provider-audio-dropped", identity: event.identity });
          return;
        }
        const responseId = state.activeProviderResponseId || identityFactory.nextProviderResponseId();
        if (!state.activeProviderResponseId) {
          dispatch({
            type: VOICE_ACTIONS.MODEL_RESPONSE_STARTED,
            sessionGeneration: state.sessionGeneration,
            providerResponseId: responseId,
            turnId: state.activeTurnId,
          });
        }
        const playbackGeneration = state.playbackGeneration || identityFactory.nextPlaybackGeneration();
        const identity = currentIdentity({ playbackGeneration });
        if (event.identity?.sessionGeneration != null && event.identity.sessionGeneration !== state.sessionGeneration) return;
        // Only a still-pending request can classify the next PCM as a cue.
        // Transcript phrase matching is unsafe because normal answers can say
        // “yeah” or “I hear you” and would poison subsequent audio chunks.
        const audioClass = backchannelManager?.hasPending?.() ? "backchannel" : "main";
        playback.schedule(event.base64Data, {
          generation: playbackGeneration,
          audioClass,
          identity,
          gain: audioClass === "backchannel" ? 0.72 : 1,
        });
        dispatch({
          type: VOICE_ACTIONS.AUDIO_RECEIVED,
          sessionGeneration: state.sessionGeneration,
          playbackGeneration,
          audioClass,
        });
        emit(Object.freeze({ ...event, identity }));
        return;
      }
      case VOICE_EVENTS.PROVIDER_INTERRUPTED: {
        // Interruption invalidates the old playback generation, but the
        // provider may immediately deliver the replacement response for the
        // same user turn. Only a completed turn is a closed response boundary.
        providerResponseClosed = false;
        localBargeInPending = false;
        backchannelManager?.cancel?.("user-interrupted");
        // A user interruption cancels the main answer, but a pending listening
        // acknowledgement is intentionally allowed to finish as a short cue.
        responseStagingManager?.cancelForTurn(state.activeTurnId, "provider-interrupted");
        const playbackGeneration = playback.handleInterruption(event.identity || currentIdentity());
        dispatch({
          type: VOICE_ACTIONS.MODEL_INTERRUPTED,
          sessionGeneration: state.sessionGeneration,
          playbackGeneration,
        });
        emit(event);
        return;
      }
      case VOICE_EVENTS.PROVIDER_TURN_COMPLETE:
        providerResponseClosed = true;
        backchannelManager?.cancel("turn-complete");
        flushPendingToolResults();
        activeTurnStartedAt = 0;
        dispatch({ type: VOICE_ACTIONS.TURN_COMPLETE, sessionGeneration: state.sessionGeneration });
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_TOOL_CALL: {
        if (!toolGateway) {
          emit(Object.freeze({ ...event, error: "tool-gateway-not-configured" }));
          return;
        }
        const call = event.call || {};
        const operationId = identityFactory.nextOperationId();
        const scheduling = event.scheduling || getToolResponseScheduling({ currentFact: call.name === "web_search" || call.name === "verify_current_fact" });
        const identity = createArtifactIdentity({
          sessionGeneration: state.sessionGeneration,
          turnId: state.activeTurnId,
          providerResponseId: state.activeProviderResponseId,
          operationId,
        });
        dispatch({ type: VOICE_ACTIONS.TOOL_STARTED, sessionGeneration: state.sessionGeneration });
        void toolGateway.execute(call.name, call.args || call.arguments || {}, { identity })
          .then((result) => {
            if (identity.sessionGeneration !== state.sessionGeneration || identity.turnId !== state.activeTurnId) return;
            dispatch({ type: result?.error ? VOICE_ACTIONS.TOOL_FAILED : VOICE_ACTIONS.TOOL_RESOLVED, sessionGeneration: state.sessionGeneration });
            const response = {
              id: call.id,
              name: call.name,
              response: { result: result || { error: "empty-tool-result" } },
            };
            pendingToolResults.push({ identity, result: result || { error: "empty-tool-result" }, response, scheduling });
            if (scheduling === "IMMEDIATE") flushPendingToolResults();
          })
          .catch((error) => {
            if (identity.sessionGeneration !== state.sessionGeneration || identity.turnId !== state.activeTurnId) return;
            const result = { error: error?.message || "tool-execution-failed" };
            dispatch({ type: VOICE_ACTIONS.TOOL_FAILED, sessionGeneration: state.sessionGeneration });
            pendingToolResults.push({ identity, result, response: { id: call.id, name: call.name, response: { result } }, scheduling });
            if (scheduling === "IMMEDIATE") flushPendingToolResults();
          });
        return;
      }
      case VOICE_EVENTS.PROVIDER_RESUMPTION_UPDATED:
        latestResumeHandle = event.resumeHandle || latestResumeHandle;
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_GO_AWAY:
        beginRecovery("provider-go-away", event);
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_ERROR:
        if (!beginRecovery("provider-error", event)) {
          dispatch({ type: VOICE_ACTIONS.FAILED, sessionGeneration: state.sessionGeneration, error: event.error });
        }
        emit(event);
        return;
      case VOICE_EVENTS.PROVIDER_CLOSED:
        beginRecovery("provider-closed", event);
        emit(event);
        return;
      default:
        emit(event);
    }
  }

  function start({ url, setup, identity = {} } = {}) {
    if (started) return false;
    const sessionGeneration = identity.sessionGeneration || identityFactory.nextSessionGeneration();
    dispatch({ type: VOICE_ACTIONS.START_REQUESTED, sessionGeneration });
    provider.updateContext?.({ sessionGeneration });
    provider.connect({
      url,
      setup,
      identity: { ...identity, sessionGeneration },
    });
    capture.start();
    persistence?.start({ sessionId: identity.sessionId, incognito: identity.incognito });
    started = true;
    return true;
  }

  function stop() {
    if (!started && state.phase === "idle") return false;
    dispatch({ type: VOICE_ACTIONS.STOP_REQUESTED, sessionGeneration: state.sessionGeneration });
    pendingToolResults.length = 0;
    latestResumeHandle = "";
    providerResponseClosed = true;
    activeTurnStartedAt = 0;
    capture.stop();
    provider.close();
    playback.flush({ reason: "session-stop" });
    started = false;
    const closePromise = persistence?.close({
      reason: "user-stop",
      reconnectCount: state.reconnectCount,
      incompleteTurn: Boolean(state.activeTurnId),
    });
    dispatch({ type: VOICE_ACTIONS.STOPPED });
    if (closePromise?.catch) void closePromise.catch(() => {});
    return true;
  }

  function sendText(text) {
    if (!started || !text) return false;
    return provider.sendText(text);
  }

  function ingestCaptureFrame(frame, metadata = {}) {
    return capture.processFrame(frame, metadata);
  }

  function requestResponseStage(request = {}) {
    if (!responseStagingManager) return { stage: "skip", reason: "staging-not-configured" };
    return responseStagingManager.start({
      ...request,
      sessionGeneration: state.sessionGeneration,
      turnId: request.turnId || state.activeTurnId,
    });
  }

  function considerBackchannel(context = {}) {
    if (!backchannelManager) return { offer: false, reason: "backchannel-not-configured" };
    return backchannelManager.consider({
      ...context,
      sessionGeneration: state.sessionGeneration,
      turnId: context.turnId || state.activeTurnId,
      isModelSpeaking: state.isModelSpeaking,
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    start,
    stop,
    sendText,
    ingestCaptureFrame,
    handleCaptureQuality,
    handleProviderEvent,
    requestResponseStage,
    considerBackchannel,
    subscribe,
    getState: () => state,
    getIdentity: currentIdentity,
    isStarted: () => started,
  });
}
