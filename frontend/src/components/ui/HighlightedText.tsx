import React from 'react';
import { searchTerms } from '../../utils/ui/search';

/** Marks each search word in `text`, case-insensitively. Plain text only: no HTML is injected. */
export const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const terms = searchTerms(query);
  if (!terms.length || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const at = lower.indexOf(term, cursor);
      if (at !== -1 && (next === -1 || at < next)) {
        next = at;
        length = term.length;
      }
    }
    if (next === -1) break;
    if (next > cursor) parts.push(text.slice(cursor, next));
    parts.push(
      <mark key={next} className="search-mark">
        {text.slice(next, next + length)}
      </mark>,
    );
    cursor = next + length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};
