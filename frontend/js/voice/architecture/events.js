export const VOICE_EVENTS = Object.freeze({
  SESSION_START: "session.start",
  SESSION_STOP: "session.stop",
  SESSION_READY: "session.ready",
  SESSION_ERROR: "session.error",
  CAPTURE_FRAME: "capture.frame",
  CAPTURE_STATE: "capture.state",
  PROVIDER_READY: "provider.ready",
  PROVIDER_INPUT_TRANSCRIPT: "provider.input-transcript",
  PROVIDER_OUTPUT_TRANSCRIPT: "provider.output-transcript",
  PROVIDER_AUDIO: "provider.audio",
  PROVIDER_TURN_COMPLETE: "provider.turn-complete",
  PROVIDER_INTERRUPTED: "provider.interrupted",
  PROVIDER_TOOL_CALL: "provider.tool-call",
  PROVIDER_GO_AWAY: "provider.go-away",
  PROVIDER_RESUMPTION_UPDATED: "provider.resumption-updated",
  PROVIDER_CLOSED: "provider.closed",
  PROVIDER_ERROR: "provider.error",
  TURN_STARTED: "turn.started",
  TURN_UPDATED: "turn.updated",
  TURN_SUPERSEDED: "turn.superseded",
  TURN_COMPLETED: "turn.completed",
  BACKCHANNEL_REQUESTED: "backchannel.requested",
  BACKCHANNEL_SKIPPED: "backchannel.skipped",
  STAGING_REQUESTED: "staging.requested",
  STAGING_SKIPPED: "staging.skipped",
  PLAYBACK_STARTED: "playback.started",
  PLAYBACK_FLUSHED: "playback.flushed",
  PLAYBACK_ENDED: "playback.ended",
  TOOL_STARTED: "tool.started",
  TOOL_RESOLVED: "tool.resolved",
  TOOL_FAILED: "tool.failed",
  EVIDENCE_PENDING: "evidence.pending",
  EVIDENCE_VERIFIED: "evidence.verified",
  EVIDENCE_REJECTED: "evidence.rejected",
  RECOVERY_STARTED: "recovery.started",
  RECOVERY_READY: "recovery.ready",
  RECOVERY_FAILED: "recovery.failed",
});

export const VOICE_COMMANDS = Object.freeze({
  GREETING: "command.greeting",
  USER_TEXT: "command.user-text",
  VERIFIED_EVIDENCE: "command.verified-evidence",
  TOOL_RESPONSE: "command.tool-response",
  CONTINUITY_SEED: "command.continuity-seed",
  BACKCHANNEL: "command.backchannel",
  THINKING_CUE: "command.thinking-cue",
  SESSION_NOTICE: "command.session-notice",
});

function freezeEvent(type, payload = {}) {
  return Object.freeze({
    type,
    at: Date.now(),
    ...payload,
  });
}

export function createVoiceEvent(type, payload = {}) {
  if (!Object.values(VOICE_EVENTS).includes(type)) {
    throw new TypeError(`Unknown Voice event: ${type}`);
  }
  return freezeEvent(type, payload);
}

export function createProviderAudioEvent({ identity, base64Data, mimeType = "audio/pcm;rate=24000" } = {}) {
  if (!identity || typeof base64Data !== "string" || !base64Data) {
    throw new TypeError("Provider audio requires identity and non-empty base64Data");
  }
  return createVoiceEvent(VOICE_EVENTS.PROVIDER_AUDIO, {
    identity: Object.freeze({ ...identity }),
    base64Data,
    mimeType,
  });
}

export function createProviderInterruptionEvent({ identity, reason = "provider-vad" } = {}) {
  if (!identity) throw new TypeError("Provider interruption requires identity");
  return createVoiceEvent(VOICE_EVENTS.PROVIDER_INTERRUPTED, {
    identity: Object.freeze({ ...identity }),
    reason,
  });
}

export function createCommand(type, payload = {}) {
  if (!Object.values(VOICE_COMMANDS).includes(type)) {
    throw new TypeError(`Unknown Voice command: ${type}`);
  }
  return Object.freeze({
    type,
    createdAt: Date.now(),
    ...payload,
  });
}
