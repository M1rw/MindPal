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
    apiKey: "AIzaSyCNyY5Dp7Umw0sLZYLgYc6-_DhNjVU7Chc",
    authDomain: "mindpal-official-0.firebaseapp.com",
    databaseURL: "https://mindpal-official-0-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "mindpal-official-0",
    storageBucket: "mindpal-official-0.firebasestorage.app",
    messagingSenderId: "234733155455",
    appId: "1:234733155455:web:a297853f71b6092b0e3b4a",
    measurementId: "G-CT1D5ZNRB8",
  };

  const config = {
    API_BASE_URL: defaultApiBase,
    VOICE_DEBUG: false,
    SHOW_RESPONSE_DEBUG: false,
    ...deploymentOverrides,
    FIREBASE_CONFIG: {
      ...firebaseDefaults,
      ...(deploymentOverrides.FIREBASE_CONFIG || {}),
    },
  };

  window.MINDPAL_CONFIG = Object.freeze({
    ...config,
    FIREBASE_CONFIG: Object.freeze({ ...config.FIREBASE_CONFIG }),
  });
})();
