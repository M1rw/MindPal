// frontend/js/api.js

import { getAppCheckToken } from "./auth.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_HISTORY_ITEM_CHARS = 12_000;
const MAX_HISTORY_TOTAL_CHARS = 64_000;


function resolveApiBaseUrl() {
  const explicit = window.MINDPAL_CONFIG?.API_BASE_URL;

  if (explicit && typeof explicit === "string") {
    return explicit.replace(/\/+$/, "");
  }

  const host = window.location.hostname;

  if (host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8000/api";
  }

  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:8000/api";
  }

  return `${window.location.origin}/api`;
}

export const API_BASE_URL = resolveApiBaseUrl();

export class MindPalApiError extends Error {
  constructor(message, { status = 0, code = "api_error", details = {}, requestId = null } = {}) {
    super(message);
    this.name = "MindPalApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

async function requestJson(path, {
  method = "GET",
  body = undefined,
  token = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  cache = "default",
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) headers["X-MindPal-Timezone"] = timezone;
  } catch {
    // Timezone is optional; backend safely falls back to UTC.
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    const appCheckToken = await getAppCheckToken();
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      cache,
    });

    const text = await response.text();
    const data = text ? safeJsonParse(text) : null;
    if (!response.ok) throw toApiError(response, data);
    return data;
  } catch (error) {
    if (error instanceof MindPalApiError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      if (!timedOut && signal?.aborted) {
        throw new DOMException("Request cancelled", "AbortError");
      }
      throw new MindPalApiError("Request timed out", { status: 0, code: "request_timeout" });
    }
    throw new MindPalApiError(error?.message || "Network request failed", { status: 0, code: "network_error" });
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Never retain or log an invalid response body; it may contain private content.
    return null;
  }
}

function toApiError(response, data) {
  const payload = data && typeof data === "object" ? data : {};

  return new MindPalApiError(
    payload.message || payload.detail?.message || `HTTP ${response.status}`,
    {
      status: response.status,
      code: payload.code || payload.detail?.code || "http_error",
      details: payload.details || payload.detail?.details || payload,
      requestId: payload.request_id || payload.detail?.request_id || null,
    },
  );
}

export function normalizeChatHistory(chatMemory, maxMessages = 30, fieldName = "text") {
  if (!Array.isArray(chatMemory)) return [];

  const outputField = fieldName === "content" ? "content" : "text";
  const normalized = chatMemory
    .slice(-Math.max(0, maxMessages))
    .map((item) => {
      const role = item?.role === "User" || item?.role === "user" ? "user" : "assistant";
      let value;
      if (item?.type === "voice_call" && item.voiceCall) {
        const parts = [`[Voice Call · ${String(item.voiceCall.durationStr || "").slice(0, 80)}]`];
        if (item.voiceCall.summary) parts.push(`Summary: ${item.voiceCall.summary}`);
        if (item.voiceCall.userTranscript) parts.push(`User said: ${item.voiceCall.userTranscript}`);
        if (item.voiceCall.aiTranscript) parts.push(`AI said: ${item.voiceCall.aiTranscript}`);
        value = parts.join("\n");
      } else {
        value = String(item?.text ?? item?.content ?? item?.message ?? "").trim();
      }
      value = value.slice(0, MAX_HISTORY_ITEM_CHARS);
      if (!value) return null;
      return outputField === "content" ? { role, content: value } : { role, text: value };
    })
    .filter(Boolean);

  let total = 0;
  const bounded = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const item = normalized[index];
    const value = item[outputField];
    if (bounded.length && total + value.length > MAX_HISTORY_TOTAL_CHARS) break;
    bounded.push(item);
    total += value.length;
  }
  return bounded.reverse();
}

export function removeTrailingDuplicateUserMessage(history, message) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage || !Array.isArray(history) || history.length === 0) return history || [];
  const next = [...history];
  const last = next[next.length - 1];
  const lastText = String(last?.content ?? last?.text ?? "").trim();
  if (last?.role === "user" && lastText === cleanMessage) next.pop();
  return next;
}



export async function health() {
  return requestJson("/health", { method: "GET", timeoutMs: 20_000 });
}

export async function getFeatureSnapshot(token = null) {
  return requestJson("/features", {
    method: "GET",
    token,
    timeoutMs: 20_000,
    cache: "no-store",
  });
}

export async function loadAdminFeaturePolicies(token) {
  return requestJson("/admin/features", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function updateAdminFeaturePolicy(featureKey, payload, token) {
  return requestJson(`/admin/features/${encodeURIComponent(featureKey)}`, {
    method: "PUT",
    token,
    timeoutMs: 20_000,
    body: payload,
  });
}

export async function patchAdminFeaturePolicy(featureKey, payload, token) {
  return requestJson(`/admin/features/${encodeURIComponent(featureKey)}`, {
    method: "PATCH",
    token,
    timeoutMs: 20_000,
    body: payload,
  });
}

export async function getCurrentUserProfile(token) {
  return requestJson("/user/me", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function loadUserProfile(token) {
  return requestJson("/user/profile", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function updateUserProfilePreferences(preferences, token) {
  return requestJson("/user/profile", {
    method: "PATCH",
    token,
    timeoutMs: 20_000,
    body: {
      preferences,
    },
  });
}



// Map UI listening preference names to backend preference IDs
// Frontend shows user-friendly names, backend receives preference identifiers
const MODE_UI_TO_BACKEND = {
  "Active Listen": "active_listen",
  "Guided Coach": "guided_coach",
  "Cognitive Tools": "cognitive_tools",
};



export async function deleteMemory(token) {
  return requestJson("/memory", {
    method: "DELETE",
    token,
    timeoutMs: 20_000,
  });
}

export async function loadMemory(token) {
  return requestJson("/memory", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function saveMemory(summary, token) {
  return requestJson("/memory", {
    method: "PUT",
    token,
    timeoutMs: 20_000,
    body: {
      summary,
    },
  });
}

export async function loadMemoryGraph(token) {
  return requestJson("/memory/v3", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function saveMemoryGraph(graph, token, expectedVersion = null) {
  const body = {
    graph,
    also_update_summary: true,
  };
  if (Number.isInteger(expectedVersion) && expectedVersion >= 1) {
    body.expected_version = expectedVersion;
  }

  return requestJson("/memory/v3", {
    method: "PUT",
    token,
    timeoutMs: 20_000,
    body,
  });
}

export async function mergeMemoryGraph(graph, token) {
  return requestJson("/memory/v3/merge", {
    method: "POST",
    token,
    timeoutMs: 20_000,
    body: {
      graph,
      also_update_summary: true,
    },
  });
}

export async function deleteMemoryGraphItem(atomId, token) {
  return requestJson(`/memory/v3/items/${encodeURIComponent(atomId)}`, {
    method: "DELETE",
    token,
    timeoutMs: 20_000,
  });
}

export async function loadBrainOverview(token) {
  return requestJson("/brain/overview", { method: "GET", token, timeoutMs: 20_000 });
}

export async function loadBrainMap(token, { focusAtomId = null, depth = 1, categories = [] } = {}) {
  const params = new URLSearchParams();
  if (focusAtomId) params.set("focus_atom_id", focusAtomId);
  params.set("depth", String(Math.max(0, Math.min(2, Number(depth) || 1))));
  if (Array.isArray(categories) && categories.length) params.set("categories", categories.join(","));
  const suffix = params.toString();
  return requestJson(`/brain/map${suffix ? `?${suffix}` : ""}`, { method: "GET", token, timeoutMs: 20_000 });
}

export async function loadBrainFocus(atomId, token) {
  return requestJson(`/brain/nodes/${encodeURIComponent(atomId)}`, { method: "GET", token, timeoutMs: 20_000 });
}

export async function searchBrain(query, token, { categories = [], limit = 30 } = {}) {
  const params = new URLSearchParams({ q: String(query || ""), limit: String(Math.max(1, Math.min(100, Number(limit) || 30)))});
  if (Array.isArray(categories) && categories.length) params.set("categories", categories.join(","));
  return requestJson(`/brain/search?${params.toString()}`, { method: "GET", token, timeoutMs: 20_000 });
}

export async function createBrainEdge(edge, token) {
  return requestJson("/brain/edges", { method: "POST", token, timeoutMs: 20_000, body: edge });
}

export async function updateBrainEdge(edgeId, action, token, expectedVersion = null) {
  const body = { action };
  if (Number.isInteger(expectedVersion) && expectedVersion >= 1) body.expected_version = expectedVersion;
  return requestJson(`/brain/edges/${encodeURIComponent(edgeId)}`, { method: "PATCH", token, timeoutMs: 20_000, body });
}

export async function resolveBrainReview(reviewId, action, token, expectedVersion = null) {
  const body = { action };
  if (Number.isInteger(expectedVersion) && expectedVersion >= 1) body.expected_version = expectedVersion;
  return requestJson(`/brain/review/${encodeURIComponent(reviewId)}`, { method: "POST", token, timeoutMs: 20_000, body });
}

export function buildClientFallbackReply(error) {
  if (error?.status === 401) {
    return "You need to sign in before using this cloud feature.";
  }

  if (error?.status === 503 || error?.code === "db_provider_unavailable") {
    return "Cloud storage is currently unavailable on the server. Your settings and messages are preserved locally.";
  }

  if (error?.code === "request_timeout") {
    return "The request took too long. Try again with a shorter message.";
  }

  return "I’m having trouble connecting right now. Take one slow breath, then try again.";
}


export async function loadCurrentCloudChat(token) {
  return requestJson("/chats/current", {
    method: "GET",
    token,
    timeoutMs: 30_000,
  });
}

export async function replaceCurrentCloudChat(messages, token, { title = "Current chat" } = {}) {
  return requestJson("/chats/current", {
    method: "PUT",
    token,
    timeoutMs: 30_000,
    body: {
      title,
      messages: Array.isArray(messages) ? messages : [],
    },
  });
}

export async function upsertCloudChatMessages(messages, token) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      status: "ok",
      chat: null,
      synced_count: 0,
    };
  }

  return requestJson("/chats/current/messages", {
    method: "POST",
    token,
    timeoutMs: 30_000,
    body: {
      messages,
    },
  });
}

export async function deleteCurrentCloudChat(token) {
  return requestJson("/chats/current", {
    method: "DELETE",
    token,
    timeoutMs: 30_000,
  });
}


export function buildChatStreamPayload({
  message,
  history = [],
  metadata = {},
  clientRequestId = null,
} = {}) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) throw new Error("Message cannot be empty");

  const normalizedHistory = removeTrailingDuplicateUserMessage(
    normalizeChatHistory(history, 60, "content"),
    cleanMessage,
  );
  const suppliedRequestId = String(clientRequestId || "").trim().slice(0, 120);
  const stableRequestId = suppliedRequestId || createClientRequestId();

  return {
    message: cleanMessage,
    history: normalizedHistory,
    metadata: {
      ...metadata,
      client_request_id: stableRequestId,
    },
    stream: true,
  };
}

export function shouldRetryStreamRequest({ error, emittedText = "", attempt = 0 } = {}) {
  if (attempt !== 0 || String(emittedText || "").trim()) return false;
  if (error?.name === "AbortError") return false;
  return error?.code === "network_error" || error?.code === "request_timeout";
}

function createClientRequestId() {
  if (globalThis.crypto?.randomUUID) return `chat_${globalThis.crypto.randomUUID()}`;
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

export async function sendChatMessageStream({
  message,
  history = [],
  locale = "en",
  channel = "web",
  mode = "Active Listen",
  model = "standard",
  token = null,
  profileContext = null,
  clientRequestId = null,
  retryAttempt = 0,
  signal = null,
  onChunk = () => {},
  onStatus = () => {},
  onMetadata = () => {},
  onError = () => {},
}) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) throw new Error("Message cannot be empty");

  const backendPreference = MODE_UI_TO_BACKEND[mode] || "active_listen";
  
  // Detect user's timezone from browser
  let userTimezone = "UTC";
  try {
    userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (e) {
    console.warn("Failed to detect timezone, using UTC:", e);
  }
  
  const metadata = { locale, channel, mode: backendPreference, model, timezone: userTimezone, ...(profileContext?.settingsMetadata || {}) };
  const requestPayload = buildChatStreamPayload({
    message: cleanMessage,
    history,
    metadata,
    clientRequestId,
  });
  const url = `${API_BASE_URL}/chat/stream`;
  const headers = { Accept: "text/event-stream", "Content-Type": "application/json", "X-MindPal-Timezone": userTimezone };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    const appCheckToken = await getAppCheckToken();
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
  }

  const controller = new AbortController();
  let timedOut = false;
  let errorReported = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Stream timed out", "TimeoutError"));
  }, STREAM_TIMEOUT_MS);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const reportError = (error) => {
    if (errorReported) return;
    errorReported = true;
    onError(error);
  };

  const dispatchEvent = (rawEvent) => {
    const dataLines = String(rawEvent || "")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length === 0) return false;
    const dataStr = dataLines.join("\n").trim();
    if (!dataStr) return false;
    if (dataStr === "[DONE]") return true;

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch (error) {
      console.warn("Failed to parse SSE JSON payload", error, dataStr.slice(0, 500));
      return false;
    }

    if (data.error) {
      throw new MindPalApiError(
        typeof data.error === "string" ? data.error : data.error.message || "Stream failed",
        {
          status: Number(data.status || 0),
          code: data.code || "stream_error",
          details: data.error,
          requestId: data.request_id || null,
        },
      );
    }
    if (data.text !== undefined) {
      const text = String(data.text);
      emittedText += text;
      onChunk(text);
    } else if (data.type === "status") onStatus(data.status);
    else if (data.type === "metadata") onMetadata(data);
    return false;
  };

  let attempt = Math.max(0, Number(retryAttempt) || 0);
  let emittedText = "";
  try {
    while (true) {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        credentials: "omit",
      });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw toApiError(response, safeJsonParse(errText));
    }
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !contentType.includes("text/event-stream")) {
        throw new MindPalApiError("Backend returned a non-streaming response", {
          status: response.status,
          code: "invalid_stream_content_type",
          details: { contentType },
        });
      }
      if (!response.body) {
        throw new MindPalApiError("Streaming response body was empty", { status: response.status, code: "empty_stream_body" });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFinished = false;
      while (!streamFinished) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (dispatchEvent(rawEvent)) { streamFinished = true; break; }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) {
          if (!streamFinished && buffer.trim()) dispatchEvent(buffer);
          break;
        }
      }
      return;
    }
  } catch (error) {
    const normalizedError = error?.name === "AbortError" || error?.name === "TimeoutError"
      ? (!timedOut && signal?.aborted
        ? new DOMException("Stream cancelled", "AbortError")
        : new MindPalApiError("Response stream timed out", { status: 0, code: "request_timeout" }))
      : (error instanceof MindPalApiError
        ? error
        : new MindPalApiError(error?.message || "Network request failed", { status: 0, code: "network_error" }));

    if (shouldRetryStreamRequest({ error: normalizedError, emittedText, attempt })) {
      attempt += 1;
      onStatus("retrying");
      return sendChatMessageStream({
        message: cleanMessage,
        history,
        locale,
        channel,
        mode,
        model,
        token,
        profileContext,
        clientRequestId: requestPayload.metadata.client_request_id,
        retryAttempt: attempt,
        signal,
        onChunk,
        onStatus,
        onMetadata,
        onError,
      });
    }
    reportError(normalizedError);
    throw normalizedError;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
