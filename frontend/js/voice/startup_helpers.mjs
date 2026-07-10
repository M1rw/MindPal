const DEFAULT_VOICE_TOKEN_PATH = "/voice/token";

export function buildVoiceTokenUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim();
  if (!normalized) return DEFAULT_VOICE_TOKEN_PATH;
  return `${normalized.replace(/\/$/, "")}${DEFAULT_VOICE_TOKEN_PATH}`;
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

function validateVoiceCredentials(data) {
  const credentials = {
    token: String(data?.token || "").trim(),
    model: String(data?.model || "").trim(),
    websocket_url: String(data?.websocket_url || "").trim(),
    expires_at: String(data?.expires_at || "").trim(),
    new_session_expires_at: String(data?.new_session_expires_at || "").trim(),
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
  fetchImpl = fetch,
  maxAttempts = 2,
  signal = null,
}) {
  let currentToken = token;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = { Accept: "application/json" };
    if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

    try {
      const response = await fetchImpl(buildVoiceTokenUrl(baseUrl), {
        method: "GET",
        headers,
        cache: "no-store",
        credentials: "omit",
        signal,
      });
      if (!response.ok) {
        const classification = classifyVoiceStartupFailure({ status: response.status });
        if (attempt < maxAttempts && classification.retryable) {
          if (classification.reason === "authentication" && typeof refreshToken === "function") {
            currentToken = await refreshToken();
          }
          continue;
        }
        const error = new Error(`Voice token fetch failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return validateVoiceCredentials(await response.json());
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      const classification = classifyVoiceStartupFailure(error);
      if (attempt < maxAttempts && classification.retryable) {
        if (classification.reason === "authentication" && typeof refreshToken === "function") {
          currentToken = await refreshToken();
        }
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Voice token fetch failed");
}
