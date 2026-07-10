// frontend/js/auth.js

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";

const AUTH_STATE_TIMEOUT_MS = 8_000;

let firebaseApp = null;
let firebaseAuth = null;
let authReadyPromise = null;
let currentAuthUser = null;

class MindPalAuthError extends Error {
  constructor(message, { code = "auth_error", cause = null } = {}) {
    super(message);
    this.name = "MindPalAuthError";
    this.code = code;
    this.cause = cause;
  }
}

function getFirebaseConfig() {
  const config = window.MINDPAL_CONFIG?.FIREBASE_CONFIG;

  if (!config || typeof config !== "object") {
    return null;
  }

  const required = ["apiKey", "authDomain", "projectId", "appId"];
  const missing = required.filter((key) => !String(config[key] || "").trim());

  if (missing.length > 0) {
    throw new MindPalAuthError(`Missing Firebase config: ${missing.join(", ")}`, {
      code: "firebase_config_missing",
    });
  }

  return config;
}

export async function initAuth() {
  if (firebaseAuth) {
    return firebaseAuth;
  }

  const firebaseConfig = getFirebaseConfig();

  if (!firebaseConfig) {
    authReadyPromise = Promise.resolve(null);
    return null;
  }

  firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  firebaseAuth = getAuth(firebaseApp);

  await setPersistence(firebaseAuth, browserLocalPersistence);

  authReadyPromise = new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      resolve(firebaseAuth.currentUser || null);
    }, AUTH_STATE_TIMEOUT_MS);

    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      window.clearTimeout(timeout);
      currentAuthUser = user;
      unsubscribe();
      resolve(user);
    });
  });

  await authReadyPromise;
  return firebaseAuth;
}

async function waitForAuthReady() {
  if (!authReadyPromise) {
    await initAuth();
  }

  return authReadyPromise;
}

export function onAuthChange(callback) {
  if (!firebaseAuth) {
    return () => {};
  }

  return onAuthStateChanged(firebaseAuth, (user) => {
    currentAuthUser = user;
    callback(toPublicUser(user));
  });
}

export function getCurrentUser() {
  return toPublicUser(currentAuthUser || firebaseAuth?.currentUser || null);
}

export async function getIdToken({ forceRefresh = false } = {}) {
  await waitForAuthReady();

  const user = firebaseAuth?.currentUser;

  if (!user) {
    return null;
  }

  try {
    return await user.getIdToken(forceRefresh);
  } catch (error) {
    throw new MindPalAuthError("Failed to read Firebase ID token", {
      code: "firebase_token_failed",
      cause: error,
    });
  }
}

export async function signInWithGoogle() {
  const auth = await initAuth();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", {
      code: "firebase_not_configured",
    });
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });

  try {
    const credential = await signInWithPopup(auth, provider);
    currentAuthUser = credential.user;
    return toPublicUser(credential.user);
  } catch (error) {
    throw new MindPalAuthError("Google sign-in failed", {
      code: error?.code || "google_sign_in_failed",
      cause: error,
    });
  }
}

export async function signOut() {
  await waitForAuthReady();

  if (!firebaseAuth) {
    currentAuthUser = null;
    return;
  }

  try {
    await firebaseSignOut(firebaseAuth);
    currentAuthUser = null;
  } catch (error) {
    throw new MindPalAuthError("Sign-out failed", {
      code: error?.code || "sign_out_failed",
      cause: error,
    });
  }
}

export function authIsConfigured() {
  return Boolean(window.MINDPAL_CONFIG?.FIREBASE_CONFIG);
}

function toPublicUser(user) {
  if (!user) {
    return null;
  }

  return {
    uid: user.uid,
    displayName: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || "",
    isAnonymous: Boolean(user.isAnonymous),
    providerId: user.providerData?.[0]?.providerId || (user.isAnonymous ? "anonymous" : "firebase"),
  };
}