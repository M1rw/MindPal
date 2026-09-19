/**
 * Unicode-aware joining for composer text and dictation utterances.
 * Inserts a Latin space only for space-delimited scripts; never uses split(' ').
 */

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
type WordSegmenter = {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

const hasSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl;

const graphemeSegmenter: GraphemeSegmenter | null = hasSegmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

const wordSegmenter: WordSegmenter | null = hasSegmenter
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;

const NO_SPACE_LETTER =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Thai}|\p{Script=Lao}|\p{Script=Khmer}/u;

const SPACE_DELIMITED_LETTER =
  /\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Greek}|\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Armenian}|\p{Script=Georgian}/u;

const SENTENCE_PUNCT = /[.?!؟！。．…]/u;
const CLOSING_PUNCT = /[)\]\}"'»”’]/u;
const HORIZONTAL_SPACE = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F]/u;

function graphemesOf(text: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text.matchAll(/\P{M}\p{M}*/gu), (match) => match[0]);
}

function firstGrapheme(text: string): string {
  if (!text) return '';
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) return part.segment;
    return '';
  }
  return graphemesOf(text)[0] ?? '';
}

function lastGrapheme(text: string): string {
  if (!text) return '';
  if (graphemeSegmenter) {
    let last = '';
    for (const part of graphemeSegmenter.segment(text)) last = part.segment;
    return last;
  }
  const parts = graphemesOf(text);
  return parts[parts.length - 1] ?? '';
}

function baseChar(grapheme: string): string {
  if (!grapheme) return '';
  return String.fromCodePoint(grapheme.codePointAt(0) ?? 0);
}

function isNoSpaceLetter(grapheme: string): boolean {
  return NO_SPACE_LETTER.test(baseChar(grapheme));
}

function isSpaceDelimitedLetter(grapheme: string): boolean {
  const ch = baseChar(grapheme);
  return SPACE_DELIMITED_LETTER.test(ch) || /\p{Nd}/u.test(ch);
}

function isLetter(grapheme: string): boolean {
  return /\p{L}/u.test(baseChar(grapheme));
}

function isDigit(grapheme: string): boolean {
  return /\p{Nd}/u.test(baseChar(grapheme));
}

function endsWithNewline(text: string): boolean {
  return /[\r\n]$/.test(text);
}

function startsWithNewline(text: string): boolean {
  return /^[\r\n]/.test(text);
}

function stripHorizontalEdge(text: string, edge: 'start' | 'end'): string {
  return edge === 'start'
    ? text.replace(/^[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F]+/u, '')
    : text.replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F]+$/u, '');
}

function startsWithWordLike(text: string): boolean {
  const trimmed = stripHorizontalEdge(text, 'start');
  if (!trimmed || startsWithNewline(trimmed)) return false;
  if (wordSegmenter) {
    for (const part of wordSegmenter.segment(trimmed)) {
      if (!part.segment.trim()) continue;
      if (part.isWordLike) return true;
      return isLetter(firstGrapheme(part.segment)) || isDigit(firstGrapheme(part.segment));
    }
    return false;
  }
  const first = firstGrapheme(trimmed);
  return isLetter(first) || isDigit(first);
}

function isSpaceDelimitedBoundary(left: string, right: string): boolean {
  const last = lastGrapheme(stripHorizontalEdge(left, 'end'));
  const first = firstGrapheme(stripHorizontalEdge(right, 'start'));
  if (!last || !first) return false;
  if (isNoSpaceLetter(last) || isNoSpaceLetter(first)) return false;
  return true;
}

function needsSeparator(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (HORIZONTAL_SPACE.test(lastGrapheme(left)) || HORIZONTAL_SPACE.test(firstGrapheme(right))) {
    return false;
  }
  if (endsWithNewline(left) || startsWithNewline(right)) return false;

  const last = lastGrapheme(left);
  const first = firstGrapheme(right);

  if (isNoSpaceLetter(last) || isNoSpaceLetter(first)) return false;
  if (isDigit(last) && isDigit(first)) return false;

  const nextIsWord =
    startsWithWordLike(right) || isSpaceDelimitedLetter(first) || isLetter(first);

  if (!nextIsWord) return false;

  if (SENTENCE_PUNCT.test(last) || CLOSING_PUNCT.test(last)) {
    return isSpaceDelimitedLetter(first) || isLetter(first);
  }

  return isSpaceDelimitedLetter(last);
}

function joinPair(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;

  if (endsWithNewline(left) || startsWithNewline(right)) {
    return left + right;
  }

  const leftHasEdge = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F]$/u.test(left);
  const rightHasEdge = /^[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F]/u.test(right);

  if (leftHasEdge || rightHasEdge) {
    if (leftHasEdge && rightHasEdge && isSpaceDelimitedBoundary(left, right)) {
      return stripHorizontalEdge(left, 'end') + ' ' + stripHorizontalEdge(right, 'start');
    }
    return left + right;
  }

  if (needsSeparator(left, right)) {
    return left + ' ' + right;
  }

  return left + right;
}

/** Join composer / dictation fragments with a script-appropriate boundary. */
export function joinText(...parts: string[]): string {
  return parts.reduce((acc, part) => joinPair(acc, part), '');
}
