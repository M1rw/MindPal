import { normalizeName } from "../utils/helpers.js";

export const STATE_KEY = "mindpal_state_v2";
export const MAX_LOCAL_CHAT_MESSAGES = 250;
export const MAX_LOCAL_MESSAGE_CHARS = 12_000;
export const MAX_LOCAL_VOICE_TRANSCRIPT_CHARS = 24_000;

export const DEFAULT_STATE = Object.freeze({
  sessionId: "",
  chatMemory: [],
  streak: 0,
  lastVisitDate: null,
  visitHistory: [],
  crisisMode: true,
  cloudSyncEnabled: false,
  userName: "Friend",
  messageCount: 0,
});

export function createDefaultState({ createId = () => "local" } = {}) {
  return {
    ...DEFAULT_STATE,
    sessionId: `mp_${createId()}`,
    chatMemory: [],
    visitHistory: [],
  };
}

export function normalizeStoredMessage(item, {
  createId = () => "local",
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
} = {}) {
  if (!item || typeof item !== "object") return null;

  const text = String(item.text || item.content || "")
    .trim()
    .slice(0, MAX_LOCAL_MESSAGE_CHARS);
  if (!text) return null;

  const next = {
    ...item,
    role: item.role === "User" || item.role === "user" ? "User" : "MindPal",
    text,
    messageId: item.messageId || item.message_id || `msg_${createId()}_${nowMs()}`,
    createdAt: item.createdAt || item.created_at || now(),
  };

  if (next.voiceCall && typeof next.voiceCall === "object") {
    next.voiceCall = {
      ...next.voiceCall,
      summary: String(next.voiceCall.summary || "").slice(0, MAX_LOCAL_MESSAGE_CHARS),
      userTranscript: String(next.voiceCall.userTranscript || "").slice(0, MAX_LOCAL_VOICE_TRANSCRIPT_CHARS),
      aiTranscript: String(next.voiceCall.aiTranscript || "").slice(0, MAX_LOCAL_VOICE_TRANSCRIPT_CHARS),
    };
  }

  return next;
}

export function normalizeStoredChatMemory(messages, options = {}) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => normalizeStoredMessage(message, options))
    .filter(Boolean)
    .slice(-MAX_LOCAL_CHAT_MESSAGES);
}

export function hydrateStoredState(parsed, options = {}) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const defaults = createDefaultState(options);

  return {
    ...defaults,
    ...source,
    chatMemory: normalizeStoredChatMemory(source.chatMemory, options),
    visitHistory: Array.isArray(source.visitHistory) ? source.visitHistory : [],
    crisisMode: source.crisisMode !== false,
    userName: normalizeName(source.userName),
  };
}

export function countUserMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter((message) => message?.role === "User").length
    : 0;
}
