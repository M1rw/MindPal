import test from "node:test";
import assert from "node:assert/strict";

import {
  createArtifactIdentity,
  createVoiceIdentityFactory,
  isCurrentArtifact,
} from "../frontend/js/voice/architecture/ids.js";
import {
  VOICE_COMMANDS,
  VOICE_EVENTS,
  createCommand,
  createProviderAudioEvent,
  createProviderInterruptionEvent,
  createVoiceEvent,
} from "../frontend/js/voice/architecture/events.js";
import {
  VOICE_ACTIONS,
  VOICE_PHASES,
  createInitialVoiceState,
  voiceStateReducer,
} from "../frontend/js/voice/architecture/state.js";
import {
  acceptsArtifact,
  assertCurrentArtifact,
} from "../frontend/js/voice/architecture/invariants.js";

test("identity factory fences sessions, turns, operations, responses, and playback", () => {
  const ids = createVoiceIdentityFactory({ now: () => 1_700_000_000_000 });
  const sessionGeneration = ids.nextSessionGeneration();
  const turnId = ids.nextTurnId();
  const responseId = ids.nextProviderResponseId();
  const operationId = ids.nextOperationId();
  const playbackGeneration = ids.nextPlaybackGeneration();
  const current = createArtifactIdentity({
    sessionGeneration,
    turnId,
    providerResponseId: responseId,
    operationId,
    playbackGeneration,
  });

  assert.equal(sessionGeneration, 1);
  assert.match(turnId, /^voice-turn-/);
  assert.match(responseId, /^voice-response-/);
  assert.match(operationId, /^voice-operation-/);
  assert.equal(playbackGeneration, 1);
  assert.equal(isCurrentArtifact(current, current, {
    requireTurn: true,
    requireResponse: true,
    requireOperation: true,
    requirePlayback: true,
  }), true);

  const staleTurn = createArtifactIdentity({ ...current, turnId: ids.nextTurnId() });
  assert.equal(isCurrentArtifact(staleTurn, current, { requireTurn: true }), false);
});

test("identity fence rejects stale session and playback artifacts", () => {
  const current = createArtifactIdentity({
    sessionGeneration: 2,
    turnId: "turn-current",
    playbackGeneration: 4,
  });
  const staleSession = createArtifactIdentity({
    sessionGeneration: 1,
    turnId: "turn-current",
    playbackGeneration: 4,
  });
  const stalePlayback = createArtifactIdentity({
    sessionGeneration: 2,
    turnId: "turn-current",
    playbackGeneration: 3,
  });

  assert.equal(acceptsArtifact(staleSession, current, { requirePlayback: true }), false);
  assert.equal(acceptsArtifact(stalePlayback, current, { requireTurn: true, requirePlayback: true }), false);
  assert.throws(
    () => assertCurrentArtifact(stalePlayback, current, { requireTurn: true, requirePlayback: true }),
    /Stale or invalid Voice artifact/,
  );
});

test("event and command contracts reject unknown values and preserve payloads", () => {
  const event = createVoiceEvent(VOICE_EVENTS.PROVIDER_READY, { sessionGeneration: 1 });
  const command = createCommand(VOICE_COMMANDS.THINKING_CUE, { operationId: "operation-1" });
  const audio = createProviderAudioEvent({
    identity: { sessionGeneration: 1, playbackGeneration: 2 },
    base64Data: "AQI=",
  });
  const interruption = createProviderInterruptionEvent({
    identity: { sessionGeneration: 1, turnId: "turn-1" },
  });

  assert.equal(event.type, VOICE_EVENTS.PROVIDER_READY);
  assert.equal(event.sessionGeneration, 1);
  assert.equal(command.type, VOICE_COMMANDS.THINKING_CUE);
  assert.equal(command.operationId, "operation-1");
  assert.equal(audio.mimeType, "audio/pcm;rate=24000");
  assert.equal(interruption.reason, "provider-vad");
  assert.throws(() => createVoiceEvent("unknown"), /Unknown Voice event/);
  assert.throws(() => createCommand("unknown"), /Unknown Voice command/);
});

test("state reducer models start, speaking, interruption, recovery, and stop", () => {
  let state = createInitialVoiceState({ now: () => 100 });
  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.START_REQUESTED,
    sessionGeneration: 1,
  }, { now: () => 101 });
  assert.equal(state.phase, VOICE_PHASES.CONNECTING);
  assert.equal(state.sessionGeneration, 1);

  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.SESSION_READY,
    sessionGeneration: 1,
  }, { now: () => 102 });
  assert.equal(state.phase, VOICE_PHASES.LISTENING);

  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.CAPTURE_SPEECH_STARTED,
    sessionGeneration: 1,
    turnId: "turn-1",
  }, { now: () => 103 });
  assert.equal(state.phase, VOICE_PHASES.USER_SPEAKING);
  assert.equal(state.activeTurnId, "turn-1");

  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.MODEL_RESPONSE_STARTED,
    sessionGeneration: 1,
    providerResponseId: "response-1",
  }, { now: () => 104 });
  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.AUDIO_RECEIVED,
    sessionGeneration: 1,
    playbackGeneration: 1,
    audioClass: "main",
  }, { now: () => 105 });
  assert.equal(state.phase, VOICE_PHASES.MODEL_SPEAKING);
  assert.equal(state.isModelSpeaking, true);

  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.MODEL_INTERRUPTED,
    sessionGeneration: 1,
    playbackGeneration: 2,
  }, { now: () => 106 });
  assert.equal(state.phase, VOICE_PHASES.USER_SPEAKING);
  assert.equal(state.isModelSpeaking, false);
  assert.equal(state.playbackGeneration, 2);

  state = voiceStateReducer(state, {
    type: VOICE_ACTIONS.RECOVERY_STARTED,
    sessionGeneration: 1,
  }, { now: () => 107 });
  assert.equal(state.phase, VOICE_PHASES.RECOVERING);
  assert.equal(state.reconnectCount, 1);

  state = voiceStateReducer(state, { type: VOICE_ACTIONS.STOPPED }, { now: () => 108 });
  assert.equal(state.phase, VOICE_PHASES.IDLE);
  assert.equal(state.activeTurnId, null);
});

test("stale state actions cannot mutate the active session", () => {
  const state = voiceStateReducer(
    voiceStateReducer(createInitialVoiceState(), {
      type: VOICE_ACTIONS.START_REQUESTED,
      sessionGeneration: 2,
    }),
    { type: VOICE_ACTIONS.SESSION_READY, sessionGeneration: 2 },
  );

  const stale = voiceStateReducer(state, {
    type: VOICE_ACTIONS.CAPTURE_SPEECH_STARTED,
    sessionGeneration: 1,
    turnId: "stale-turn",
  });

  assert.equal(stale, state);
  assert.equal(stale.phase, VOICE_PHASES.LISTENING);
  assert.equal(stale.activeTurnId, null);
});
