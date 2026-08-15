// frontend/js/auth.js

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  OAuthProvider,
  RecaptchaVerifier,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {
  getToken as getFirebaseAppCheckToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";

const AUTH_STATE_TIMEOUT_MS = 8_000;

let firebaseApp = null;
let firebaseAuth = null;
let firebaseAppCheck = null;
let authReadyPromise = null;
let currentAuthUser = null;
let phoneRecaptchaVerifier = null;
let phoneConfirmationResult = null;
let redirectDiagnostic = {
  status: "idle",
  provider: "",
  code: "",
};

const REDIRECT_PENDING_KEY = "mindpal.firebase.redirect.pending.v1";

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

  const appCheckSiteKey = String(window.MINDPAL_CONFIG?.FIREBASE_APPCHECK_SITE_KEY || "").trim();
  if (appCheckSiteKey && !firebaseAppCheck) {
    try {
      firebaseAppCheck = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (error) {
      throw new MindPalAuthError("Firebase App Check initialization failed", {
        code: "firebase_app_check_init_failed",
        cause: error,
      });
    }
  }

  await setPersistence(firebaseAuth, browserLocalPersistence);

  // Firebase redirect sign-in must be consumed after the browser returns from
  // the auth handler. We persist only the selected provider name so the Account
  // panel can report a safe, actionable status if Firebase restores no user.
  const pendingRedirect = readPendingRedirect();
  try {
    const redirectResult = await getRedirectResult(firebaseAuth);
    if (redirectResult?.user) {
      currentAuthUser = redirectResult.user;
      redirectDiagnostic = { status: "completed", provider: pendingRedirect?.provider || "", code: "" };
      clearPendingRedirect();
    } else if (pendingRedirect) {
      redirectDiagnostic = { status: "no_credential", provider: pendingRedirect.provider, code: "" };
    }
  } catch (error) {
    redirectDiagnostic = {
      status: "failed",
      provider: pendingRedirect?.provider || "",
      code: String(error?.code || "firebase_redirect_result_failed"),
    };
    // A previous redirect attempt can fail after returning to the app while
    // still leaving a completed Firebase initialization available. Do not
    // prevent popup-based providers from starting because of that stale event.
    clearPendingRedirect();
  }

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

export async function getAppCheckToken({ forceRefresh = false } = {}) {
  await waitForAuthReady();

  if (!firebaseAppCheck) {
    return null;
  }

  try {
    const result = await getFirebaseAppCheckToken(firebaseAppCheck, forceRefresh);
    return String(result?.token || "").trim() || null;
  } catch (error) {
    throw new MindPalAuthError("Failed to obtain Firebase App Check token", {
      code: "firebase_app_check_token_failed",
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
    const code = String(error?.code || "");
    throw new MindPalAuthError("Google sign-in failed", {
      code: code || "google_sign_in_failed",
      cause: error,
    });
  }
}

async function signInWithOAuthProvider(provider, providerName) {
  const auth = await initAuth();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", { code: "firebase_not_configured" });
  }


  try {
    const credential = await signInWithPopup(auth, provider);
    currentAuthUser = credential.user;
    return toPublicUser(credential.user);
  } catch (error) {
    const code = String(error?.code || "");
    throw new MindPalAuthError(`${providerName} sign-in failed`, {
      code: code || "provider_sign_in_failed",
      cause: error,
    });
  }
}

export async function signInWithApple() {
  const provider = new OAuthProvider("apple.com");
  provider.addScope("email");
  provider.addScope("name");
  return signInWithOAuthProvider(provider, "Apple");
}

export async function startPhoneNumberSignIn(phoneNumber, recaptchaContainer) {
  const auth = await initAuth();
  const normalizedPhoneNumber = String(phoneNumber || "").trim();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", { code: "firebase_not_configured" });
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhoneNumber.replace(/[\s()-]/g, ""))) {
    throw new MindPalAuthError("Enter a complete mobile number with country code", { code: "invalid_phone_number" });
  }
  if (!(recaptchaContainer instanceof HTMLElement)) {
    throw new MindPalAuthError("Phone verification is not available", { code: "phone_recaptcha_missing" });
  }

  clearPhoneNumberSignIn();

  try {
    phoneRecaptchaVerifier = new RecaptchaVerifier(auth, recaptchaContainer, { size: "normal" });
    await phoneRecaptchaVerifier.render();
    phoneConfirmationResult = await signInWithPhoneNumber(auth, normalizedPhoneNumber.replace(/[\s()-]/g, ""), phoneRecaptchaVerifier);
    return true;
  } catch (error) {
    clearPhoneNumberSignIn();
    throw new MindPalAuthError("Phone verification could not be started", {
      code: error?.code || "phone_sign_in_failed",
      cause: error,
    });
  }
}

export async function confirmPhoneNumberSignIn(code) {
  const normalizedCode = String(code || "").replace(/\s/g, "");

  if (!phoneConfirmationResult) {
    throw new MindPalAuthError("Request a new verification code", { code: "phone_confirmation_missing" });
  }
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new MindPalAuthError("Enter the 6-digit verification code", { code: "invalid_verification_code" });
  }

  try {
    const credential = await phoneConfirmationResult.confirm(normalizedCode);
    currentAuthUser = credential.user;
    clearPhoneNumberSignIn();
    return toPublicUser(credential.user);
  } catch (error) {
    throw new MindPalAuthError("Phone verification failed", {
      code: error?.code || "phone_confirmation_failed",
      cause: error,
    });
  }
}

export function clearPhoneNumberSignIn() {
  phoneConfirmationResult = null;
  if (phoneRecaptchaVerifier) {
    try { phoneRecaptchaVerifier.clear(); } catch {}
  }
  phoneRecaptchaVerifier = null;
}

export async function signInWithEmailPassword(email, password) {
  const auth = await initAuth();
  const normalizedEmail = String(email || "").trim();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", { code: "firebase_not_configured" });
  }
  if (!normalizedEmail || !password) {
    throw new MindPalAuthError("Enter both your email and password", { code: "email_password_required" });
  }

  try {
    const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
    currentAuthUser = credential.user;
    return toPublicUser(credential.user);
  } catch (error) {
    throw new MindPalAuthError("Email sign-in failed", {
      code: error?.code || "email_sign_in_failed",
      cause: error,
    });
  }
}

export async function createAccountWithEmailPassword(email, password) {
  const auth = await initAuth();
  const normalizedEmail = String(email || "").trim();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", { code: "firebase_not_configured" });
  }
  if (!normalizedEmail || !password) {
    throw new MindPalAuthError("Enter both your email and password", { code: "email_password_required" });
  }

  try {
    const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
    currentAuthUser = credential.user;
    return toPublicUser(credential.user);
  } catch (error) {
    throw new MindPalAuthError("Account creation failed", {
      code: error?.code || "email_account_creation_failed",
      cause: error,
    });
  }
}

export async function sendPasswordReset(email) {
  const auth = await initAuth();
  const normalizedEmail = String(email || "").trim();

  if (!auth) {
    throw new MindPalAuthError("Firebase is not configured", { code: "firebase_not_configured" });
  }
  if (!normalizedEmail) {
    throw new MindPalAuthError("Enter your email address first", { code: "email_required" });
  }

  try {
    await sendPasswordResetEmail(auth, normalizedEmail);
  } catch (error) {
    throw new MindPalAuthError("Password reset could not be sent", {
      code: error?.code || "password_reset_failed",
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
  return Boolean(window.MINDPAL_CONFIG?.FIREBASE_ENABLED);
}

export function getAuthRedirectDiagnostic() {
  return { ...redirectDiagnostic };
}

function readPendingRedirect() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(REDIRECT_PENDING_KEY) || "null");
    const provider = String(value?.provider || "").trim();
    return provider ? { provider } : null;
  } catch {
    return null;
  }
}

function clearPendingRedirect() {
  try {
    window.sessionStorage.removeItem(REDIRECT_PENDING_KEY);
  } catch {}
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