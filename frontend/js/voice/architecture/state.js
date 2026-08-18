export const VOICE_PHASES = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  LISTENING: "listening",
  USER_SPEAKING: "user-speaking",
  THINKING: "thinking",
  MODEL_SPEAKING: "model-speaking",
  USER_INTERRUPTING: "user-interrupting-model",
  TOOL_PENDING: "tool-pending",
  RECOVERING: "recovering",
  STOPPING: "stopping",
  ERROR: "error",
});

export const VOICE_ACTIONS = Object.freeze({
  START_REQUESTED: "start-requested",
  SESSION_READY: "session-ready",
  CAPTURE_SPEECH_STARTED: "capture-speech-started",
  INPUT_TRANSCRIPT_UPDATED: "input-transcript-updated",
  MODEL_RESPONSE_STARTED: "model-response-started",
  AUDIO_RECEIVED: "audio-received",
  MODEL_INTERRUPTED: "model-interrupted",
  LOCAL_BARGE_IN_PENDING: "local-barge-in-pending",
  LOCAL_BARGE_IN_RELEASED: "local-barge-in-released",
  TURN_COMPLETE: "turn-complete",
  TOOL_STARTED: "tool-started",
  TOOL_RESOLVED: "tool-resolved",
  BACKCHANNEL_STARTED: "backchannel-started",
  STAGING_STARTED: "staging-started",
  PLAYBACK_ENDED: "playback-ended",
  RECOVERY_STARTED: "recovery-started",
  RECOVERY_READY: "recovery-ready",
  RECOVERY_FAILED: "recovery-failed",
  STOP_REQUESTED: "stop-requested",
  STOPPED: "stopped",
  FAILED: "failed",
});

export function createInitialVoiceState({ now = Date.now } = {}) {
  return Object.freeze({
    phase: VOICE_PHASES.IDLE,
    sessionGeneration: 0,
    activeTurnId: null,
    activeProviderResponseId: null,
    playbackGeneration: 0,
    captureSpeechActive: false,
    isMicMuted: false,
    isModelSpeaking: false,
    localBargeInPending: false,
    isBackchannelPlaying: false,
    isThinkingCuePlaying: false,
    pendingToolCount: 0,
    pendingEvidenceCount: 0,
    reconnectCount: 0,
    lastActivityAt: now(),
    error: null,
  });
}

function withActivity(state, patch = {}, now = Date.now) {
  return Object.freeze({
    ...state,
    ...patch,
    lastActivityAt: now(),
  });
}

function nextPlaybackGeneration(state, action) {
  const requested = Number(action.playbackGeneration);
  if (Number.isInteger(requested) && requested > state.playbackGeneration) return requested;
  return state.playbackGeneration + 1;
}

export function voiceStateReducer(state, action, { now = Date.now } = {}) {
  if (!state || !action) return state;
  const type = action.type;

  switch (type) {
    case VOICE_ACTIONS.START_REQUESTED:
      if (state.phase !== VOICE_PHASES.IDLE && state.phase !== VOICE_PHASES.ERROR) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.CONNECTING,
        sessionGeneration: Number(action.sessionGeneration) || state.sessionGeneration + 1,
        activeTurnId: null,
        activeProviderResponseId: null,
        playbackGeneration: 0,
        error: null,
      }, now);

    case VOICE_ACTIONS.SESSION_READY:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, { phase: VOICE_PHASES.LISTENING, error: null }, now);

    case VOICE_ACTIONS.CAPTURE_SPEECH_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: state.isModelSpeaking ? VOICE_PHASES.USER_INTERRUPTING : VOICE_PHASES.USER_SPEAKING,
        captureSpeechActive: true,
        activeTurnId: action.turnId || state.activeTurnId,
      }, now);

    case VOICE_ACTIONS.INPUT_TRANSCRIPT_UPDATED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        activeTurnId: action.turnId || state.activeTurnId,
        phase: state.isModelSpeaking ? VOICE_PHASES.USER_INTERRUPTING : VOICE_PHASES.USER_SPEAKING,
      }, now);

    case VOICE_ACTIONS.MODEL_RESPONSE_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.THINKING,
        activeProviderResponseId: action.providerResponseId || state.activeProviderResponseId,
        activeTurnId: action.turnId || state.activeTurnId,
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
      }, now);

    case VOICE_ACTIONS.AUDIO_RECEIVED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      if (action.playbackGeneration != null && action.playbackGeneration < state.playbackGeneration) return state;
      return withActivity(state, {
        phase: action.audioClass === "backchannel" ? state.phase : VOICE_PHASES.MODEL_SPEAKING,
        playbackGeneration: action.playbackGeneration ?? state.playbackGeneration,
        isModelSpeaking: action.audioClass !== "backchannel",
        isBackchannelPlaying: action.audioClass === "backchannel",
        isThinkingCuePlaying: action.audioClass === "thinking-cue",
      }, now);

    case VOICE_ACTIONS.LOCAL_BARGE_IN_PENDING:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.USER_INTERRUPTING,
        localBargeInPending: true,
      }, now);

    case VOICE_ACTIONS.LOCAL_BARGE_IN_RELEASED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        localBargeInPending: false,
        phase: state.isModelSpeaking ? VOICE_PHASES.MODEL_SPEAKING : VOICE_PHASES.LISTENING,
      }, now);

    case VOICE_ACTIONS.MODEL_INTERRUPTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: state.isMicMuted ? VOICE_PHASES.LISTENING : VOICE_PHASES.USER_SPEAKING,
        playbackGeneration: nextPlaybackGeneration(state, action),
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
        activeProviderResponseId: null,
      }, now);

    case VOICE_ACTIONS.TURN_COMPLETE:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: state.isMicMuted ? VOICE_PHASES.LISTENING : VOICE_PHASES.LISTENING,
        captureSpeechActive: false,
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
        activeProviderResponseId: null,
        pendingEvidenceCount: 0,
      }, now);

    case VOICE_ACTIONS.TOOL_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.TOOL_PENDING,
        pendingToolCount: state.pendingToolCount + 1,
      }, now);

    case VOICE_ACTIONS.TOOL_RESOLVED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: state.isModelSpeaking ? VOICE_PHASES.MODEL_SPEAKING : VOICE_PHASES.THINKING,
        pendingToolCount: Math.max(0, state.pendingToolCount - 1),
      }, now);

    case VOICE_ACTIONS.BACKCHANNEL_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        isBackchannelPlaying: true,
        isThinkingCuePlaying: false,
      }, now);

    case VOICE_ACTIONS.STAGING_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.THINKING,
        isThinkingCuePlaying: true,
        isBackchannelPlaying: false,
      }, now);

    case VOICE_ACTIONS.PLAYBACK_ENDED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      if (action.playbackGeneration != null && action.playbackGeneration !== state.playbackGeneration) return state;
      return withActivity(state, {
        phase: state.captureSpeechActive ? VOICE_PHASES.USER_SPEAKING : VOICE_PHASES.LISTENING,
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
      }, now);

    case VOICE_ACTIONS.RECOVERY_STARTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, {
        phase: VOICE_PHASES.RECOVERING,
        reconnectCount: state.reconnectCount + 1,
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
      }, now);

    case VOICE_ACTIONS.RECOVERY_READY:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, { phase: VOICE_PHASES.LISTENING, error: null }, now);

    case VOICE_ACTIONS.RECOVERY_FAILED:
    case VOICE_ACTIONS.FAILED:
      if (action.sessionGeneration != null && action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, { phase: VOICE_PHASES.ERROR, error: action.error || "voice-error" }, now);

    case VOICE_ACTIONS.STOP_REQUESTED:
      if (action.sessionGeneration !== state.sessionGeneration) return state;
      return withActivity(state, { phase: VOICE_PHASES.STOPPING }, now);

    case VOICE_ACTIONS.STOPPED:
      return withActivity(state, {
        phase: VOICE_PHASES.IDLE,
        activeTurnId: null,
        activeProviderResponseId: null,
        isModelSpeaking: false,
        localBargeInPending: false,
        isBackchannelPlaying: false,
        isThinkingCuePlaying: false,
        pendingToolCount: 0,
        pendingEvidenceCount: 0,
      }, now);

    default:
      return state;
  }
}
