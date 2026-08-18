// frontend/js/voice_session.js — stable public Voice facade with reversible V2 rollout.

import { createVoiceSessionController } from "./voice/runtime.js";
import { createVoiceSessionV2 } from "./voice_session_v2.js";

const useVoiceV2 = Boolean(globalThis.window?.MINDPAL_CONFIG?.VOICE_ARCHITECTURE_V2);
const controller = useVoiceV2 ? createVoiceSessionV2() : createVoiceSessionController();

export function getSessionState() {
  return controller.getSessionState();
}

export function getMicMuted() { return controller.getMicMuted(); }
export function getAiSpeaking() { return controller.getAiSpeaking(); }
export function getSpeakerMuted() { return controller.getSpeakerMuted(); }

export function setSpeakerMuted(muted) {
  return controller.setSpeakerMuted(muted);
}

export function setMuted(muted) {
  return controller.setMuted(muted);
}

export async function startSession(options = {}) {
  return controller.startSession(options);
}

export function stopSession() {
  return controller.stopSession();
}

export function sendTextToModel(text) {
  return controller.sendTextToModel(text);
}

