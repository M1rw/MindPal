export function buildVoiceKeyUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) return '/voice/key';
  return `${normalized.replace(/\/$/, '')}/voice/key`;
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
