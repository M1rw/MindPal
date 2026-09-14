/**
 * Firebase App Initialization
 * Reads configuration from the __MINDPAL_BOOTSTRAP__ JSON node,
 * injected synchronously into the document by the server on GET /.
 * See: backend/main.py → _build_public_bootstrap_payload()
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import { getAppConfig, getFirebaseConfig, isFirebaseConfigured } from '../config';

export { isFirebaseConfigured };

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _appCheck: AppCheck | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  const config = getFirebaseConfig();
  if (!config) return null;

  if (!_app) {
    if (getApps().length > 0) {
      _app = getApps()[0];
    } else {
      _app = initializeApp(config);
    }
  }
  return _app;
}

export function getFirebaseAuth(): Auth | null {
  const app = getFirebaseApp();
  if (!app) return null;
  if (!_auth) {
    _auth = getAuth(app);
  }
  return _auth;
}

export function initFirebaseAppCheck(): AppCheck | null {
  if (_appCheck) return _appCheck;
  const app = getFirebaseApp();
  if (!app) return null;

  const siteKey = getAppConfig().FIREBASE_APPCHECK_SITE_KEY;
  if (!siteKey) return null;

  try {
    _appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    return _appCheck;
  } catch {
    return null;
  }
}
