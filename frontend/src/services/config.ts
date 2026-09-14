/**
 * MindPal Enterprise Client Configuration Service
 *
 * Implements Tier-1 Document JSON Bootstrapping (Pattern B).
 * Synchronously reads and freezes the immutable bootstrap payload injected
 * into the HTML document root by the backend server.
 */

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
  googleClientId?: string;
}

export interface MindPalBootstrapConfig {
  API_BASE_URL: string;
  ENVIRONMENT: string;
  FIREBASE_APPCHECK_SITE_KEY?: string;
  FIREBASE_CONFIG: FirebaseClientConfig | null;
  FIREBASE_ENABLED: boolean;
}

type WindowWithBootstrap = Window & {
  MINDPAL_CONFIG?: MindPalBootstrapConfig;
};

let _cachedConfig: MindPalBootstrapConfig | null = null;

/**
 * Resolves the immutable client bootstrap configuration.
 * Priority:
 * 1. Server-injected <script id="__MINDPAL_BOOTSTRAP__" type="application/json"> (Pattern B)
 * 2. Window object fallback (window.MINDPAL_CONFIG)
 * 3. Default fallback for local isolated static development
 */
export function getAppConfig(): MindPalBootstrapConfig {
  if (_cachedConfig) {
    return _cachedConfig;
  }

  // 1. Attempt Document JSON Bootstrapping (Pattern B)
  if (typeof document !== 'undefined') {
    const bootstrapEl = document.getElementById('__MINDPAL_BOOTSTRAP__');
    if (bootstrapEl?.textContent) {
      try {
        const parsed = JSON.parse(bootstrapEl.textContent);
        if (parsed && typeof parsed === 'object') {
          _cachedConfig = Object.freeze(parsed) as MindPalBootstrapConfig;
          return _cachedConfig;
        }
      } catch (e) {
        console.warn('Failed to parse __MINDPAL_BOOTSTRAP__ script block:', e);
      }
    }
  }

  // 2. Fallback to window.MINDPAL_CONFIG
  if (typeof window !== 'undefined') {
    const bootstrapWindow = window as WindowWithBootstrap;
    if (bootstrapWindow.MINDPAL_CONFIG) {
      _cachedConfig = Object.freeze(bootstrapWindow.MINDPAL_CONFIG) as MindPalBootstrapConfig;
      return _cachedConfig;
    }
  }

  // 3. Fallback for static development
  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  _cachedConfig = Object.freeze({
    API_BASE_URL: isLocal ? 'http://127.0.0.1:8000/api' : '/api',
    ENVIRONMENT: isLocal ? 'development' : 'production',
    FIREBASE_APPCHECK_SITE_KEY: '',
    FIREBASE_CONFIG: null,
    FIREBASE_ENABLED: false,
  });

  return _cachedConfig;
}

/**
 * Returns the active Firebase Web configuration or null if unconfigured.
 */
export function getFirebaseConfig(): FirebaseClientConfig | null {
  return getAppConfig().FIREBASE_CONFIG;
}

/**
 * Returns whether Firebase client auth is active and configured.
 */
export function isFirebaseConfigured(): boolean {
  return Boolean(getFirebaseConfig());
}

/**
 * Returns the normalized API base URL.
 */
export function getApiBaseUrl(): string {
  const base = getAppConfig().API_BASE_URL || '/api';
  return base.replace(/\/$/, '');
}
