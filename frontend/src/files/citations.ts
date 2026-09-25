/**
 * Page citations in replies: "[p. 12]" becomes a chip that opens the PDF at
 * that page. Applied to sanitised HTML, and it only ever inserts fixed markup
 * around digits, so it cannot introduce anything unsafe.
 */
import type { ChatMessage } from '../types/index.ts';
import type { MessageAttachment } from './types.ts';

const CITE = /\[(?:p|pp|page)\.?\s?(\d{1,4})\]/gi;

export function withPageCitations(html: string): string {
  if (!html.includes('[')) return html;
  // Text between tags only: never touch attribute values.
  return html.replace(/>([^<]*)</g, (_match, text: string) => {
    const replaced = text.replace(
      CITE,
      (_m, n: string) => `<button type="button" class="page-cite" data-page="${n}" aria-label="Open page ${n}">p. ${n}</button>`,
    );
    return `>${replaced}<`;
  });
}

/** For each message, the newest PDF shared at or before it (what "[p. N]" refers to). */
export function citationTargets(messages: ChatMessage[]): Array<MessageAttachment | undefined> {
  let latest: MessageAttachment | undefined;
  return messages.map((message) => {
    const pdf = [...(message.attachments ?? [])].reverse().find((a) => a.kind === 'pdf');
    if (pdf) latest = pdf;
    return latest;
  });
}
