// Deployment-owned, non-secret browser configuration.
// Override window.MINDPAL_RUNTIME_CONFIG before this file when embedding MindPal.
(() => {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const defaultApiBase = isLocal
    ? "http://127.0.0.1:8000/api"
    : window.location.protocol === "file:"
      ? "http://127.0.0.1:8000/api"
      : `${window.location.origin}/api`;

  const deploymentOverrides = window.MINDPAL_RUNTIME_CONFIG || {};
  const firebaseDefaults = {
    apiKey: "",
    authDomain: "",
    databaseURL: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: "",
    measurementId: "",
  };

  const config = {
    API_BASE_URL: defaultApiBase,
    VOICE_DEBUG: false,
    SHOW_RESPONSE_DEBUG: false,
    FIREBASE_APPCHECK_SITE_KEY: String(deploymentOverrides.FIREBASE_APPCHECK_SITE_KEY || "").trim(),
    ...deploymentOverrides,
    FIREBASE_CONFIG: {
      ...firebaseDefaults,
      ...(deploymentOverrides.FIREBASE_CONFIG || {}),
    },
  };

  const firebaseConfig = config.FIREBASE_CONFIG;
  const firebaseReady = [
    firebaseConfig.apiKey,
    firebaseConfig.authDomain,
    firebaseConfig.projectId,
    firebaseConfig.appId,
  ].every((value) => String(value || "").trim());

  window.MINDPAL_CONFIG = Object.freeze({
    ...config,
    FIREBASE_CONFIG: firebaseReady ? Object.freeze({ ...firebaseConfig }) : null,
  });
})();
