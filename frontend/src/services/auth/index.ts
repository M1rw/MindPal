/**
 * MindPal Auth Service
 * Wraps Firebase Auth methods: Google, Apple, Phone, Email/Password
 * Mirrors the API surface of the legacy frontend/js/services/auth.js
 */

import {
  GoogleAuthProvider,
  OAuthProvider,
  RecaptchaVerifier,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  getIdToken as firebaseGetIdToken,
  type User,
  type ConfirmationResult,
} from 'firebase/auth';
import { getToken as appCheckGetToken } from 'firebase/app-check';
import { getFirebaseAuth, initFirebaseAppCheck } from '../firebase/index';
import type { AuthUser } from '../../types/index';

/** Convert Firebase User to our AuthUser shape */
function toAuthUser(user: User): AuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    emailVerified: user.emailVerified,
  };
}

/** Get current Firebase user or null */
export function getCurrentUser(): AuthUser | null {
  const auth = getFirebaseAuth();
  if (!auth?.currentUser) return null;
  return toAuthUser(auth.currentUser);
}

/** Get the current ID token (refreshes if needed) */
export async function getIdToken(opts?: { forceRefresh?: boolean }): Promise<string | null> {
  const auth = getFirebaseAuth();
  if (!auth?.currentUser) return null;
  try {
    return await firebaseGetIdToken(auth.currentUser, opts?.forceRefresh ?? false);
  } catch {
    return null;
  }
}

/** Get Firebase AppCheck token */
export async function getAppCheckToken(): Promise<string | null> {
  try {
    const appCheck = initFirebaseAppCheck();
    if (!appCheck) return null;
    const result = await appCheckGetToken(appCheck);
    return result.token;
  } catch {
    return null;
  }
}

/** Subscribe to auth state changes */
export function onAuthStateChange(callback: (user: AuthUser | null) => void): () => void {
  const auth = getFirebaseAuth();
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => {
    callback(user ? toAuthUser(user) : null);
  });
}

/** Sign in with Google */
export async function signInWithGoogle(): Promise<AuthUser> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');
  const provider = new GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  const result = await signInWithPopup(auth, provider);
  return toAuthUser(result.user);
}

/** Sign in with Apple */
export async function signInWithApple(): Promise<AuthUser> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');
  const provider = new OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  const result = await signInWithPopup(auth, provider);
  return toAuthUser(result.user);
}

/** Sign in with Email + Password */
export async function signInWithEmailPassword(email: string, password: string): Promise<AuthUser> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');
  const result = await signInWithEmailAndPassword(auth, email, password);
  return toAuthUser(result.user);
}

/** Create an account with Email + Password */
export async function createAccountWithEmailPassword(email: string, password: string): Promise<AuthUser> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return toAuthUser(result.user);
}

/** Send a password reset email */
export async function sendPasswordReset(email: string): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');
  await sendPasswordResetEmail(auth, email);
}

/** Start phone number sign-in — returns ConfirmationResult */
let _recaptchaVerifier: RecaptchaVerifier | null = null;

export async function startPhoneNumberSignIn(
  phoneNumber: string,
  recaptchaContainerId: string,
): Promise<ConfirmationResult> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase auth is not configured.');

  if (!_recaptchaVerifier) {
    _recaptchaVerifier = new RecaptchaVerifier(auth, recaptchaContainerId, { size: 'invisible' });
  }
  return signInWithPhoneNumber(auth, phoneNumber, _recaptchaVerifier);
}

/** Confirm phone number OTP code */
export async function confirmPhoneCode(
  confirmationResult: ConfirmationResult,
  code: string,
): Promise<AuthUser> {
  const result = await confirmationResult.confirm(code);
  return toAuthUser(result.user);
}

/** Sign out */
export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) return;
  await firebaseSignOut(auth);
}

/** Format human-readable auth error messages */
export function formatAuthError(error: unknown): string {
  const errorDetails = error as Partial<{ code?: string; message?: string }> | null;
  const code = String(errorDetails?.code ?? '');
  if (code.includes('invalid-credential') || code.includes('wrong-password')) return 'That email or password is not correct.';
  if (code.includes('user-not-found')) return 'No MindPal account exists for that email yet.';
  if (code.includes('email-already-in-use')) return 'An account already exists for that email. Try signing in instead.';
  if (code.includes('weak-password')) return 'Use a password with at least 6 characters.';
  if (code.includes('invalid-email')) return 'Enter a valid email address.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a moment and try again.';
  if (code.includes('invalid-phone-number')) return 'Enter a complete mobile number with its country code.';
  if (code.includes('invalid-verification-code')) return 'That verification code is not correct. Try again or request a new one.';
  if (code.includes('code-expired') || code.includes('session-expired')) return 'That verification code expired. Request a new one.';
  if (code.includes('operation-not-allowed')) return 'This sign-in method is not enabled yet.';
  if (code.includes('popup-closed-by-user')) return 'Sign-in was cancelled.';
  if (code.includes('network-request-failed')) return 'Network error. Check your connection and try again.';
  return errorDetails?.message ?? 'An unexpected error occurred. Please try again.';
}
