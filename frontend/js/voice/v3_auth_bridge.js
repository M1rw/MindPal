import { getAppCheckToken, getIdToken, initAuth } from "../auth.js";

export async function initializeVoiceV3Auth() {
  await initAuth();
}

export async function getVoiceV3IdToken({ forceRefresh = false } = {}) {
  await initAuth();
  return getIdToken({ forceRefresh });
}

export async function getVoiceV3AppCheckToken({ forceRefresh = false } = {}) {
  await initAuth();
  return getAppCheckToken({ forceRefresh });
}

export async function hasVoiceV3AuthConfiguration() {
  await initAuth();
  return Boolean(window.MINDPAL_CONFIG?.FIREBASE_ENABLED);
}

window.__MINDPAL_V3_AUTH__ = {
  initializeVoiceV3Auth,
  getVoiceV3IdToken,
  getVoiceV3AppCheckToken,
  hasVoiceV3AuthConfiguration,
};
