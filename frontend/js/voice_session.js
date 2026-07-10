// frontend/js/voice_session.js — compatibility layer over the modular voice runtime

import { createVoiceSessionController } from "./voice/runtime.js";

const controller = createVoiceSessionController();

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

