// frontend/js/api.js

const DEFAULT_TIMEOUT_MS = 45_000;

const PRODUCTION_API_BASE_URL = "https://mindpal-demo.vercel.app/api";

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
    return PRODUCTION_API_BASE_URL;
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
} = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers = {
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
    });

    const text = await response.text();
    const data = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      throw toApiError(response, data);
    }

    return data;
  } catch (error) {
    if (error instanceof MindPalApiError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new MindPalApiError("Request timed out", {
        status: 0,
        code: "request_timeout",
      });
    }

    throw new MindPalApiError(error?.message || "Network request failed", {
      status: 0,
      code: "network_error",
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
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

export function normalizeChatHistory(chatMemory, maxMessages = 30) {
  if (!Array.isArray(chatMemory)) return [];

  return chatMemory
    .slice(-maxMessages)
    .map((item) => {
      const role = item.role === "User" || item.role === "user" ? "user" : "assistant";
      const content = String(item.text ?? item.content ?? "").trim();

      return { role, content };
    })
    .filter((item) => item.content.length > 0);
}

export async function healthLive() {
  return requestJson("/health/live", { method: "GET", timeoutMs: 10_000 });
}

export async function health() {
  return requestJson("/health", { method: "GET", timeoutMs: 20_000 });
}

export async function getCurrentUserProfile(token) {
  return requestJson("/user/me", {
    method: "GET",
    token,
    timeoutMs: 20_000,
  });
}

export async function sendChatMessage({
  message,
  history = [],
  locale = "en",
  channel = "web",
  mode = "Active Listen",
  token = null,
}) {
  const cleanMessage = String(message || "").trim();

  if (!cleanMessage) {
    throw new MindPalApiError("Message cannot be empty", {
      code: "empty_message",
    });
  }

  return requestJson("/chat", {
    method: "POST",
    token,
    timeoutMs: 60_000,
    body: {
      message: cleanMessage,
      history,
      metadata: {
        locale,
        channel,
        mode,
      },
    },
  });
}

export async function getTtsPolicy({
  text,
  locale = "en",
  responseMode = "normal_support",
  safetyLevel = "safe",
  token = null,
}) {
  return requestJson("/tts/policy", {
    method: "POST",
    token,
    timeoutMs: 15_000,
    body: {
      text,
      locale,
      response_mode: responseMode,
      safety_level: safetyLevel,
    },
  });
}

export async function synthesizeTts({
  text,
  locale = "en",
  responseMode = "normal_support",
  safetyLevel = "safe",
  voiceId = null,
  token,
}) {
  return requestJson("/tts/synthesize", {
    method: "POST",
    token,
    timeoutMs: 45_000,
    body: {
      text,
      locale,
      response_mode: responseMode,
      safety_level: safetyLevel,
      voice_id: voiceId,
      format: "mp3",
    },
  });
}

export async function deleteMemory(token) {
  return requestJson("/memory", {
    method: "DELETE",
    token,
    timeoutMs: 20_000,
  });
}

export function buildClientFallbackReply(error) {
  if (error?.status === 401) {
    return "You need to sign in before using this cloud feature.";
  }

  if (error?.code === "request_timeout") {
    return "The request took too long. Try again with a shorter message.";
  }

  return "I’m having trouble connecting right now. Take one slow breath, then try again.";
}