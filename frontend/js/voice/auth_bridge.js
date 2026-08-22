import { getAppCheckToken, getIdToken, initAuth } from "../auth.js";

export async function initializeVoiceAuth() {
  await initAuth();
}

export async function getVoiceIdToken({ forceRefresh = false } = {}) {
  await initAuth();
  return getIdToken({ forceRefresh });
}

export async function getVoiceAppCheckToken({ forceRefresh = false } = {}) {
  await initAuth();
  return getAppCheckToken({ forceRefresh });
}

export async function hasVoiceAuthConfiguration() {
  await initAuth();
  return Boolean(window.MINDPAL_CONFIG?.FIREBASE_ENABLED);
}

export const initializeVoiceV3Auth = initializeVoiceAuth;
export const getVoiceV3IdToken = getVoiceIdToken;
export const getVoiceV3AppCheckToken = getVoiceAppCheckToken;
export const hasVoiceV3AuthConfiguration = hasVoiceAuthConfiguration;

const authBridge = {
  initializeVoiceAuth,
  getVoiceIdToken,
  getVoiceAppCheckToken,
  hasVoiceAuthConfiguration,
  initializeVoiceV3Auth,
  getVoiceV3IdToken,
  getVoiceV3AppCheckToken,
  hasVoiceV3AuthConfiguration,
};

window.__MINDPAL_VOICE_AUTH__ = authBridge;
window.__MINDPAL_V3_AUTH__ = authBridge;
