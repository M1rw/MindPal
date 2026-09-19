import type { ChatMessage, ChatSession } from '../../types/index.ts';

/** Live-turn notice only — never persist Review/Undo on saved sessions. */
export function withoutMemoryReceipts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!('memoryReceipt' in message)) return message;
    const { memoryReceipt: _ignored, ...rest } = message;
    return rest;
  });
}

export function withoutSessionMemoryReceipts(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: withoutMemoryReceipts(session.messages ?? []),
  };
}

export function sessionMessagesFingerprint(
  messages: Array<Pick<ChatMessage, 'id' | 'role' | 'content'>>
): string {
  return messages.map((message) => `${message.id}\0${message.role}\0${message.content}`).join('\n');
}

export function shouldBumpSessionTimestamp(
  existingMessages: Array<Pick<ChatMessage, 'id' | 'role' | 'content'>> | undefined,
  nextMessages: Array<Pick<ChatMessage, 'id' | 'role' | 'content'>>
): boolean {
  if (!existingMessages) return true;
  return sessionMessagesFingerprint(existingMessages) !== sessionMessagesFingerprint(nextMessages);
}

const LEADING_GREETING =
  /^(?:hey|hi|hello|yo|sup|hiya|my bad|good\s+(?:morning|afternoon|evening)|how(?:'s|s| is| are) you(?: doing)?(?: bro)?|what'?s up)(?:[,!.?\s]+|$)/i;

const FEELING =
  /^(?:i(?:'m| am)?\s+)?(?:just\s+)?(?:feel(?:ing)?|felt)\s+(.+)$/i;

const HELP =
  /^(?:can you |could you |please )*(?:help(?: me)?(?: with)?|i need help with)\s+(.+)$/i;

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function clampTitle(title: string, max = 42): string {
  if (title.length <= max) return title;
  const slice = title.slice(0, max - 1);
  const breakAt = slice.lastIndexOf(' ');
  return `${(breakAt > 16 ? slice.slice(0, breakAt) : slice).trim()}…`;
}

/** Short history label in the ChatGPT/Claude style — not a raw first-message dump. */
/** Compact duration for the Call ended divider. Empty when the length is unknown. */
export function formatCallDuration(usedS?: number | null): string {
  const seconds = Math.max(0, Math.round(Number(usedS) || 0));
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Application note for Gemini Live so a call started from an open thread
 * stays on that conversation. Never a greeting script.
 */
export function threadContinuation(messages: ChatMessage[]): string {
  const turns = messages
    .filter((message) => message.kind !== 'voice_receipt' && message.content.trim())
    .slice(-8);
  if (turns.length === 0) return '';
  const lines = turns.map((message) => {
    const who = message.role === 'user' ? 'User' : 'MindPal';
    const text = message.content.replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${who}: ${text}`;
  });
  return [
    'Continuing the same MindPal conversation on a live voice call.',
    'Recent text thread:',
    ...lines,
    'Stay on this thread. Do not greet as if you just met. Do not read this note aloud.',
  ].join('\n');
}

export function deriveSessionTitle(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';

  text = text.split(/(?<=[.!?])\s+/)[0] ?? text;

  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(LEADING_GREETING, '').trim();
    if (next === text) break;
    text = next;
  }

  if (!text) return 'Checking in';

  text = text.replace(/[.!?]+$/g, '').trim();
  if (!text) return 'Checking in';

  const feeling = text.match(FEELING);
  if (feeling?.[1]) {
    return clampTitle(sentenceCase(`Feeling ${feeling[1]}`));
  }

  const help = text.match(HELP);
  if (help?.[1]) {
    return clampTitle(sentenceCase(help[1]));
  }

  return clampTitle(sentenceCase(text));
}
