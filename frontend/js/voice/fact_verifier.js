const VOICE_FACT_VERIFY_PATH = "/voice/verify-current-fact";

export function buildVoiceFactVerifyUrl(baseUrl = "") {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `${base}${VOICE_FACT_VERIFY_PATH}` || VOICE_FACT_VERIFY_PATH;
}

export async function verifyCurrentVoiceFact({
  query,
  baseUrl = "",
  token = null,
  appCheckToken = null,
  fetchImpl = fetch,
  signal = null,
} = {}) {
  const cleanQuery = String(query || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
  if (!cleanQuery) return { verified: false, error: "verification_query_missing" };

  const headers = { "Content-Type": "application/json" };
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) headers["X-MindPal-Timezone"] = timezone;
  } catch {
    // The backend safely falls back to UTC when the browser does not expose a timezone.
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;

  try {
    const response = await fetchImpl(buildVoiceFactVerifyUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ query: cleanQuery }),
      credentials: "omit",
      signal,
    });
    if (!response.ok) return { verified: false, error: `verification_http_${response.status}` };
    const payload = await response.json();
    if (!payload?.verified || !payload?.evidence) {
      return { verified: false, error: payload?.error || "verification_unavailable" };
    }
    return { verified: true, evidence: payload.evidence, query: payload.query || cleanQuery };
  } catch (error) {
    return {
      verified: false,
      error: error?.name === "AbortError" ? "verification_cancelled" : "verification_unavailable",
    };
  }
}
