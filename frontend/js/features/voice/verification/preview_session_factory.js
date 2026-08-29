import { createVoiceSession } from "../orchestrator/index.js";

const TOKEN_PATH = "/voice/v4/token";
const GOOGLE_LIVE_WS_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const RELEASE_ENVIRONMENTS = new Set(["preview", "staging", "production"]);
const DEFAULT_VOICE_NAME = "Kore";
const DEFAULT_INSTRUCTION = "You are MindPal. Respond naturally and concisely in audio. Do not claim to have feelings or abilities you do not have.";

export class VoicePreviewFactoryError extends Error {
  constructor(code, message = "Voice preview is unavailable") {
    super(message);
    this.name = "VoicePreviewFactoryError";
    this.code = code;
  }
}

export function createVoicePreviewSessionFactory(options = {}) {
  const normalized = normalizeFactoryOptions(options);
  if (!isPreviewEnabled(normalized)) return undefined;
  validateFactoryDependencies(normalized);
  const issueToken = createTokenProvider(normalized);
  return (callbacks = {}) => createPreviewSession(normalized, issueToken, callbacks);
}

export const createVoiceV4PreviewSessionFactory = createVoicePreviewSessionFactory;

function normalizeFactoryOptions(options) {
  return {
    ...options,
    environment: normalizeEnvironment(options.environment),
    apiBaseUrl: normalizeBaseUrl(options.apiBaseUrl),
    voiceName: options.voiceName || DEFAULT_VOICE_NAME,
    instruction: options.instruction || DEFAULT_INSTRUCTION,
  };
}

function isPreviewEnabled({ enabled, environment }) {
  return enabled === true && RELEASE_ENVIRONMENTS.has(environment);
}

function validateFactoryDependencies(options) {
  requireFunction(options.getFeatureState, "feature_state_reader");
  requireFunction(options.getReleaseDecision, "release_decision_reader");
  requireFunction(options.getIdToken, "id_token_reader");
  requireFunction(options.fetchImpl || globalThis.fetch, "fetch_adapter");
  requireFunction(options.WebSocketConstructor || globalThis.WebSocket, "web_socket_constructor");
  requireFunction(options.captureFactory, "capture_factory");
  requireFunction(options.playbackFactory, "playback_factory");
  requireText(options.processorUrl, "processor_url");
  requireText(options.instruction, "instruction");
}

function createPreviewSession(options, issueToken, callbacks) {
  const featureState = options.getFeatureState("voice.live_v4");
  const releaseDecision = options.getReleaseDecision(featureState);
  if (options.explicitApproval !== true || releaseDecision?.allowed !== true) {
    throw new VoicePreviewFactoryError("voice_preview_unavailable");
  }
  return createVoiceSession({
    tokenProvider: { issueToken },
    // resumptionHandle is passed as 3rd arg by the orchestrator on reconnect
    socketFactory: (token, _generation, resumptionHandle) =>
      createGoogleLiveSocket(token, resumptionHandle, options.WebSocketConstructor || globalThis.WebSocket),
    captureFactory: ({ onFrame, onError, onSpeechStart, onSpeechEnd, onLevel }) =>
      options.captureFactory({
        processorUrl: options.processorUrl,
        onFrame,
        onError,
        onSpeechStart,
        onSpeechEnd,
        onLevel,
        vadOptions: options.vadOptions,
      }),
    playbackFactory: ({ onError }) => options.playbackFactory({ onError }),
    instruction: options.instruction,
    voiceName: options.voiceName,
    useClientVad: true,          // always use client VAD for lowest interruption latency
    ...callbacks,
  });
}

function createTokenProvider({ apiBaseUrl, getIdToken, getAppCheckToken, fetchImpl = globalThis.fetch }) {
  return async function issueToken() {
    const idToken = await getIdToken();
    if (!idToken) throw new VoicePreviewFactoryError("voice_auth_required");
    const headers = { Accept: "application/json", Authorization: `Bearer ${idToken}` };
    const appCheckToken = await getAppCheckToken?.();
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
    const response = await requestToken(fetchImpl, `${apiBaseUrl}${TOKEN_PATH}`, headers);
    const payload = await readJsonSafely(response);
    if (!response.ok) throw new VoicePreviewFactoryError(safeErrorCode(payload?.code || payload?.detail?.code, "voice_token_failed"));
    return normalizeGrant(payload);
  };
}

async function requestToken(fetchImpl, url, headers) {
  try {
    return await fetchImpl(url, { method: "POST", headers, credentials: "omit" });
  } catch (error) {
    throw new VoicePreviewFactoryError("voice_token_network_error");
  }
}

function createGoogleLiveSocket(token, resumptionHandle, WebSocketConstructor) {
  if (typeof token !== "string" || token.length === 0) throw new VoicePreviewFactoryError("voice_token_invalid");
  try {
    let url = `${GOOGLE_LIVE_WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
    // Append resumption handle when available so the server restores session state
    if (typeof resumptionHandle === "string" && resumptionHandle.length > 0) {
      url += `&session_handle=${encodeURIComponent(resumptionHandle)}`;
    }
    return new WebSocketConstructor(url);
  } catch (error) {
    throw new VoicePreviewFactoryError("voice_socket_unavailable");
  }
}

async function readJsonSafely(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function normalizeGrant(payload) {
  if (!payload || typeof payload.token !== "string" || payload.token.length === 0) {
    throw new VoicePreviewFactoryError("voice_token_invalid");
  }
  return {
    token: payload.token,
    expiresAtUtc: payload.expires_at_utc || "",
    newSessionExpiresAtUtc: payload.new_session_expires_at_utc || "",
    model: payload.model || "",
    protocolVersion: payload.protocol_version || "",
    requestId: payload.request_id || "",
  };
}

function normalizeEnvironment(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "unknown";
}

function normalizeBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function safeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function requireFunction(target, name) {
  if (typeof target !== "function") throw new TypeError(`${name}_must_be_function`);
}

function requireText(target, name) {
  if (typeof target !== "string" || target.trim().length === 0) throw new TypeError(`${name}_must_be_string`);
}
