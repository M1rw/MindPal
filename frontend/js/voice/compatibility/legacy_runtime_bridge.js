import { createVoiceSessionOrchestrator } from "../orchestrator/voice_session_orchestrator.js";

/**
 * Adapts the new orchestrator to the narrow controller surface consumed by the
 * existing UI. Production wiring is explicit so the legacy runtime remains the
 * default until the capability flag and integration tests are complete.
 */
export function createArchitectureV2Controller({
  provider,
  capture,
  playback,
  onState = () => {},
  onSessionEnd = () => {},
} = {}) {
  const orchestrator = createVoiceSessionOrchestrator({ provider, capture, playback });
  let micMuted = false;
  let speakerMuted = false;

  orchestrator.subscribe((_event, state) => {
    onState({
      isActive: orchestrator.isStarted(),
      isMicMuted: micMuted,
      isAiSpeaking: state.isModelSpeaking,
      isSpeakerMuted: speakerMuted,
      phase: state.phase,
      reconnectAttempts: state.reconnectCount,
    });
  });

  return Object.freeze({
    async startSession(options = {}) {
      return orchestrator.start(options);
    },
    stopSession() {
      const stopped = orchestrator.stop();
      if (stopped) onSessionEnd();
      return stopped;
    },
    setMuted(nextMuted) {
      micMuted = Boolean(nextMuted);
      capture.setMuted?.(micMuted);
      return micMuted;
    },
    setSpeakerMuted(nextMuted) {
      speakerMuted = Boolean(nextMuted);
      playback.setMuted?.(speakerMuted);
      return speakerMuted;
    },
    sendTextToModel(text) {
      return orchestrator.sendText(text);
    },
    getSessionState() {
      const state = orchestrator.getState();
      return {
        isActive: orchestrator.isStarted(),
        isMicMuted: micMuted,
        isAiSpeaking: state.isModelSpeaking,
        isSpeakerMuted: speakerMuted,
        phase: state.phase,
        reconnectAttempts: state.reconnectCount,
        micAnalyser: null,
        aiAnalyser: null,
      };
    },
    getMicMuted: () => micMuted,
    getAiSpeaking: () => orchestrator.getState().isModelSpeaking,
    getSpeakerMuted: () => speakerMuted,
    getOrchestrator: () => orchestrator,
  });
}
