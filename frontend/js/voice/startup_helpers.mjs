const DEFAULT_VOICE_TOKEN_PATH = "/voice/token";

export function buildVoiceTokenUrl(baseUrl, { fallbackGrant = null } = {}) {
  const normalized = String(baseUrl || "").trim();
  const endpoint = normalized ? `${normalized.replace(/\/$/, "")}${DEFAULT_VOICE_TOKEN_PATH}` : DEFAULT_VOICE_TOKEN_PATH;
  if (!fallbackGrant) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}fallback_grant=${encodeURIComponent(String(fallbackGrant))}`;
}

export function buildEphemeralVoiceWebSocketUrl(credentials) {
  const endpoint = String(credentials?.websocket_url || "").trim();
  const token = String(credentials?.token || "").trim();
  if (!endpoint || !token) throw new Error("Secure voice credentials are incomplete.");
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}access_token=${encodeURIComponent(token)}`;
}

export function classifySocketClose({ code, reason, wasClean, hasSetupComplete, greetingSent }) {
  const closeCode = typeof code === "number" ? code : null;

  if (closeCode === 4000) {
    return { retryable: true, shouldStop: false, reason: "stale-connection" };
  }

  if (wasClean || closeCode === 1000 || closeCode === 1001) {
    return { retryable: false, shouldStop: true, reason: "normal" };
  }

  if (hasSetupComplete && greetingSent && (closeCode === 1006 || closeCode === 1011 || closeCode === 1005 || closeCode === 4000 || closeCode === null)) {
    return { retryable: true, shouldStop: false, reason: "transient" };
  }

  if (hasSetupComplete && !greetingSent) {
    return { retryable: true, shouldStop: false, reason: "setup-incomplete" };
  }

  if (typeof reason === "string" && /timeout|network|socket|reset|aborted|going away/i.test(reason)) {
    return { retryable: true, shouldStop: false, reason: "transient-reason" };
  }

  return { retryable: false, shouldStop: true, reason: "unexpected" };
}

export function classifyVoiceStartupFailure(error) {
  if (!error || typeof error !== "object") {
    return { retryable: true, reason: "network", status: null };
  }

  const status = typeof error.status === "number" ? error.status : null;
  if (status === 401 || status === 403) {
    return { retryable: true, reason: "authentication", status };
  }
  if (status === 408 || status === 425 || status === 429 || (status && status >= 500)) {
    return { retryable: true, reason: status === 429 ? "rate-limit" : "server", status };
  }
  if (status === 410) {
    return { retryable: false, reason: "client-upgrade-required", status };
  }
  if (status === 0 || error.name === "TypeError" || error.name === "AbortError" || /fetch|network|socket|timeout/i.test(String(error.message || ""))) {
    return { retryable: true, reason: "network", status };
  }
  return { retryable: false, reason: "unknown", status };
}

export function parseVoiceRetryAfterMs(response, now = Date.now()) {
  const headers = response?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("Retry-After")
    : (headers?.["Retry-After"] ?? headers?.["retry-after"] ?? "");
  const value = String(raw || "").trim();
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function tokenFetchError(response) {
  const error = new Error(`Voice token fetch failed with status ${response.status}`);
  error.status = response.status;
  const retryAfterMs = parseVoiceRetryAfterMs(response);
  if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
  return error;
}

function validateVoiceCredentials(data) {
  const credentials = {
    token: String(data?.token || "").trim(),
    model: String(data?.model || "").trim(),
    websocket_url: String(data?.websocket_url || "").trim(),
    expires_at: String(data?.expires_at || "").trim(),
    new_session_expires_at: String(data?.new_session_expires_at || "").trim(),
    fallback_grant: String(data?.fallback_grant || "").trim(),
    fallback_used: data?.fallback_used === true,
  };
  if (!credentials.token || !credentials.model || !credentials.websocket_url) {
    const error = new Error("Voice token response was incomplete.");
    error.status = 502;
    throw error;
  }
  return credentials;
}

export async function fetchVoiceTokenWithRetry({
  baseUrl,
  token,
  refreshToken,
  appCheckToken = null,
  refreshAppCheckToken = null,
  fetchImpl = fetch,
  maxAttempts = 2,
  signal = null,
  fallbackGrant = null,
}) {
  let currentToken = token;
  let currentAppCheckToken = appCheckToken;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = { Accept: "application/json" };
    if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
    if (currentAppCheckToken) headers["X-Firebase-AppCheck"] = currentAppCheckToken;

    try {
      const response = await fetchImpl(buildVoiceTokenUrl(baseUrl, { fallbackGrant }), {
        method: "GET",
        headers,
        cache: "no-store",
        credentials: "omit",
        signal,
      });
      if (!response.ok) {
        const error = tokenFetchError(response);
        const classification = classifyVoiceStartupFailure(error);
        // A 429 is a server-directed wait, not a transient network failure. Do
        // not consume this function's retry budget while the server says wait.
        if (classification.reason === "rate-limit") throw error;
        if (attempt < maxAttempts && classification.retryable) {
          if (classification.reason === "authentication") {
            if (typeof refreshToken === "function") currentToken = await refreshToken();
            if (typeof refreshAppCheckToken === "function") currentAppCheckToken = await refreshAppCheckToken();
          }
          continue;
        }
        throw error;
      }

      return validateVoiceCredentials(await response.json());
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      const classification = classifyVoiceStartupFailure(error);
      // Preserve rate-limit metadata for the recovery scheduler and never retry
      // it here. A retry here would amplify a single 429 into a token storm.
      if (classification.reason === "rate-limit") throw error;
      if (attempt < maxAttempts && classification.retryable) {
        if (classification.reason === "authentication") {
          if (typeof refreshToken === "function") currentToken = await refreshToken();
          if (typeof refreshAppCheckToken === "function") currentAppCheckToken = await refreshAppCheckToken();
        }
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Voice token fetch failed");
}
