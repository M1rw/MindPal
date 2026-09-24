/**
 * Search helpers for the command palette: every word must appear (in any
 * order), and a chat that matches in its messages shows the matching line.
 */

import type { ChatSession } from '../../types/index.ts';

/** Lowercased words of a query; blanks removed. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesAll(haystack: string, terms: string[]): boolean {
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}

const SNIPPET_CHARS = 90;

/** A short window of `text` around the first term, with ellipses where cut. */
export function snippetAround(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return flat.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - 30);
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface ChatMatch {
  session: ChatSession;
  /** Set when the match is in a message rather than the title. */
  snippet?: string;
}

/**
 * Chats matching every word, title matches first. A title match needs no
 * snippet; otherwise the first message containing all the words is shown
 * (or, failing that, the first containing any of them).
 */
export function searchChats(sessions: ChatSession[], query: string): ChatMatch[] {
  const terms = searchTerms(query);
  if (!terms.length) return sessions.map((session) => ({ session }));
  const inTitle: ChatMatch[] = [];
  const inBody: ChatMatch[] = [];
  for (const session of sessions) {
    if (matchesAll(session.title, terms)) {
      inTitle.push({ session });
      continue;
    }
    const all = session.messages.map((m) => m.content).join('\n');
    if (!matchesAll(`${session.title}\n${all}`, terms)) continue;
    const line =
      session.messages.find((m) => matchesAll(m.content, terms)) ??
      session.messages.find((m) => terms.some((t) => m.content.toLowerCase().includes(t)));
    inBody.push({ session, snippet: line ? snippetAround(line.content, terms) : undefined });
  }
  return [...inTitle, ...inBody];
}
