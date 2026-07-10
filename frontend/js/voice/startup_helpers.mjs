export function buildVoiceKeyUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) return '/voice/key';
  return `${normalized.replace(/\/$/, '')}/voice/key`;
}

export function classifySocketClose({ code, reason, wasClean, hasSetupComplete, greetingSent }) {
  const closeCode = typeof code === 'number' ? code : null;

  if (wasClean || closeCode === 1000 || closeCode === 1001) {
    return { retryable: false, shouldStop: true, reason: 'normal' };
  }

  if (hasSetupComplete && greetingSent && (closeCode === 1006 || closeCode === 1011 || closeCode === 1005 || closeCode === 1008 || closeCode === null)) {
    return { retryable: true, shouldStop: false, reason: 'transient' };
  }

  if (hasSetupComplete && !greetingSent) {
    return { retryable: true, shouldStop: false, reason: 'setup-incomplete' };
  }

  if (typeof reason === 'string' && /timeout|network|socket|reset|aborted/i.test(reason)) {
    return { retryable: true, shouldStop: false, reason: 'transient-reason' };
  }

  return { retryable: false, shouldStop: true, reason: 'unexpected' };
}

export function classifyVoiceStartupFailure(error) {
  if (!error || typeof error !== 'object') {
    return { retryable: true, reason: 'network', status: null };
  }

  const status = typeof error.status === 'number' ? error.status : null;
  if (status === 401 || status === 403) {
    return { retryable: true, reason: 'authentication', status };
  }
  if (status && status >= 500) {
    return { retryable: true, reason: 'server', status };
  }
  if (status === 0 || error.name === 'TypeError' || /fetch|network|socket|timeout/i.test(String(error.message || ''))) {
    return { retryable: true, reason: 'network', status };
  }
  return { retryable: false, reason: 'unknown', status };
}

export async function fetchVoiceKeyWithRetry({
  baseUrl,
  token,
  refreshToken,
  fetchImpl = fetch,
  maxAttempts = 2,
}) {
  let currentToken = token;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = { 'Content-Type': 'application/json' };
    if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

    try {
      const response = await fetchImpl(buildVoiceKeyUrl(baseUrl), { headers });
      if (!response.ok) {
        const classification = classifyVoiceStartupFailure({ status: response.status });
        if (attempt < maxAttempts && classification.retryable) {
          if (typeof refreshToken === 'function') {
            currentToken = await refreshToken();
          }
          continue;
        }
        throw new Error(`Voice key fetch failed with status ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      lastError = error;
      const classification = classifyVoiceStartupFailure(error);
      if (attempt < maxAttempts && classification.retryable) {
        if (typeof refreshToken === 'function') {
          currentToken = await refreshToken();
        }
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Voice key fetch failed');
}
