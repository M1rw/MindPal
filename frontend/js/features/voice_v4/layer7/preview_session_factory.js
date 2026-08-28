import { createVoiceSession } from "../layer5/index.js";

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

export function createVoiceV4PreviewSessionFactory(options = {}) {
  const normalized = normalizeFactoryOptions(options);
  if (!isPreviewEnabled(normalized)) return undefined;
  validateFactoryDependencies(normalized);
  const issueToken = createTokenProvider(normalized);
  return (callbacks = {}) => createPreviewSession(normalized, issueToken, callbacks);
}

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
  if (options.explicitApproval !== true || releaseDecision?.allowed !== true) throw new VoicePreviewFactoryError("voice_preview_unavailable");
  return createVoiceSession({
    tokenProvider: { issueToken },
    socketFactory: (token) => createGoogleLiveSocket(token, options.WebSocketConstructor || globalThis.WebSocket),
    captureFactory: ({ onFrame, onError }) => options.captureFactory({ processorUrl: options.processorUrl, onFrame, onError }),
    playbackFactory: ({ onError }) => options.playbackFactory({ onError }),
    instruction: options.instruction,
    voiceName: options.voiceName,
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

function createGoogleLiveSocket(token, WebSocketConstructor) {
  if (typeof token !== "string" || token.length === 0) throw new VoicePreviewFactoryError("voice_token_invalid");
  try {
    return new WebSocketConstructor(`${GOOGLE_LIVE_WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
  } catch (error) {
    throw new VoicePreviewFactoryError("voice_socket_unavailable");
  }
}

async function readJsonSafely(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch (error) {
    return {};
  }
}

function normalizeGrant(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const token = typeof source.token === "string" ? source.token.trim() : "";
  const expiresAt = typeof source.expires_at_utc === "string" ? source.expires_at_utc : "";
  if (!token || !expiresAt) throw new VoicePreviewFactoryError("voice_token_invalid");
  return { token, expires_at_utc: expiresAt };
}

function normalizeEnvironment(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function requireFunction(value, code) {
  if (typeof value !== "function") throw new VoicePreviewFactoryError(code);
}

function requireText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new VoicePreviewFactoryError(code);
}

function safeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value) ? value : fallback;
}
