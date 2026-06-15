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

export function normalizeChatHistory(chatMemory, maxMessages = 30, fieldName = "text") {
  if (!Array.isArray(chatMemory)) return [];

  const outputField = fieldName === "content" ? "content" : "text";

  return chatMemory
    .slice(-maxMessages)
    .map((item) => {
      const role = item.role === "User" || item.role === "user" ? "user" : "assistant";
      const value = String(item.text ?? item.content ?? item.message ?? "").trim();

      if (!value) return null;

      return outputField === "content"
        ? { role, content: value }
        : { role, text: value };
    })
    .filter(Boolean);
}

function isValidationError(error) {
  return error instanceof MindPalApiError && error.status === 422;
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


function buildAuthenticatedContextPrefix(profileContext) {
  if (!profileContext?.authenticated) return "";

  const lines = [
    "Verified authenticated user context:",
    "- authenticated: true",
  ];

  if (profileContext.displayName) {
    lines.push(`- display_name: ${String(profileContext.displayName).trim()}`);
  }

  if (profileContext.email) {
    lines.push(`- email: ${String(profileContext.email).trim()}`);
  }

  lines.push(
    "",
    "Assistant instruction:",
    "Use this verified context when the user asks about their own identity or profile.",
    "If the user asks for their name, answer from display_name when available.",
    "Do not say you do not have access to their name when display_name is present.",
    "",
    "User message:",
  );

  return `${lines.join("\\n")}\\n`;
}

// Map UI listening preference names to backend preference IDs
// Frontend shows user-friendly names, backend receives preference identifiers
const MODE_UI_TO_BACKEND = {
  "Active Listen": "active_listen",
  "Guided Coach": "guided_coach",
  "Cognitive Tools": "cognitive_tools",
};

export async function sendChatMessage({
  message,
  history = [],
  locale = "en",
  channel = "web",
  mode = "Active Listen",
  token = null,
  profileContext = null,
}) {
  const cleanMessage = String(message || "").trim();

  if (!cleanMessage) {
    throw new MindPalApiError("Message cannot be empty", {
      code: "empty_message",
    });
  }

  // Map UI mode name to backend preference ID
  const backendPreference = MODE_UI_TO_BACKEND[mode] || "active_listen";
  const normalizedHistory = normalizeChatHistory(history, 60, "content");

  const metadata = {
    locale,
    mode: backendPreference,  // Send as preference hint, not locked mode
    ...(profileContext?.settingsMetadata || {}),
  };

  return requestJson("/chat", {
    method: "POST",
    token,
    timeoutMs: 60_000,
    body: {
      // Send clean message only. Authenticated context goes in system prompt via backend.
      message: cleanMessage,
      history: normalizedHistory,
      metadata,
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

export async function saveMemoryGraph(graph, token) {
  return requestJson("/memory/v3", {
    method: "PUT",
    token,
    timeoutMs: 20_000,
    body: {
      graph,
      also_update_summary: true,
    },
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

export function buildClientFallbackReply(error) {
  if (error?.status === 401) {
    return "You need to sign in before using this cloud feature.";
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


export async function sendChatMessageStream({
  message,
  history = [],
  locale = "en",
  channel = "web",
  mode = "Active Listen",
  token = null,
  profileContext = null,
  onChunk = (text) => {},
  onMetadata = (meta) => {},
  onError = (error) => {}
}) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) throw new Error("Message cannot be empty");

  const backendPreference = MODE_UI_TO_BACKEND[mode] || "active_listen";
  const normalizedHistory = normalizeChatHistory(history, 60, "content");
  const metadata = { locale, mode: backendPreference, ...(profileContext?.settingsMetadata || {}) };

  const url = "/api/chat/stream";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: cleanMessage, history: normalizedHistory, metadata, stream: true }),
    });

    if (!response.ok) {
      throw new Error(`Stream error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (data.error) {
                onError(new Error(data.error));
              } else if (data.text !== undefined) {
                onChunk(data.text);
              } else if (data.type === 'metadata') {
                onMetadata(data);
              }
            } catch (e) {
              console.warn("Failed to parse SSE chunk", dataStr);
            }
          }
        }
      }
    }
  } catch (error) {
    onError(error);
    throw error;
  }
}
