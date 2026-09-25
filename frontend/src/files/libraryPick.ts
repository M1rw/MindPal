/**
 * "What did my lease say about pets?" from a guest: their library lives on
 * this device, so the server cannot look in it. Before sending, a message that
 * points at their files is matched against the local library here, and the
 * best file goes along flagged `library` (MindPal found it; they did not
 * attach it). Mirrors backend/domain/files/lookup.py, which does this for
 * accounts.
 */
import type { Digest } from './types.ts';

const REFERENCE = new RegExp(
  [
    '\\b(?:my|the|that|this|those|these)\\s+(?:pdfs?|documents?|docs?|files?|notes|slides|lease|contract|syllabus|' +
      'report|screenshots?|scans?|photos?|pictures?|receipts?|letter|paper|book|chapter)\\b',
    '\\b(?:i\\s+(?:uploaded|shared|saved|sent)|in\\s+my\\s+library|from\\s+my\\s+library)\\b',
    '(?:ملفي|الملف|ملفاتي|المستند|مستندي|الوثيقة|الصورة\\s+اللي|صورتي|المكتبة|مكتبتي|العقد|الملخص\\s+اللي)',
  ].join('|'),
  'i',
);

const STOP = new Set(
  ('the and for with that this what from about have does into your their there which when where would could ' +
    'should please tell show explain summary summarize summarise my me is it of to in on a an do did can say says ' +
    'file files document documents pdf image photo picture library uploaded upload ' +
    'في عن من على الى إلى شو ايش وش مكتوب قال قالت اللي الي هل ما كيف وين متى هذا هذه ذلك تلك انا أنا عندي ملف ملفي الملف المستند').split(' ').map((word) => normalizeArabic(word)),
);

/** Same bar as the server: a file only comes along when it clearly matches. */
export const MIN_SCORE = 0.34;

export function pointsAtFiles(message: string): boolean {
  return REFERENCE.test(message || '');
}

/**
 * Arabic words match across their common forms: alef variants, taa marbuta,
 * alef maqsura, and the article or a one-letter prefix ("القطة", "بقطة" and
 * "قطة" are the same cat). Other scripts pass through unchanged.
 */
export function normalizeArabic(word: string): string {
  if (!/[؀-ۿ]/.test(word)) return word;
  let out = word.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  const article = /^(?:وال|بال|كال|فال|لل|ال)/;
  if (article.test(out) && out.replace(article, '').length >= 3) out = out.replace(article, '');
  else if (/^[بوفل]/.test(out) && out.length >= 5) out = out.slice(1);
  return out;
}

export function tokens(text: string): Set<string> {
  const words = (text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return new Set(words.map(normalizeArabic).filter((word) => word.length >= 2 && !STOP.has(word)));
}

export interface PickCandidate {
  id: string;
  name: string;
  digest: Digest;
}

function share(wanted: Set<string>, found: Set<string>): number {
  let hits = 0;
  for (const word of wanted) if (found.has(word)) hits += 1;
  return wanted.size ? hits / wanted.size : 0;
}

export function scoreFile(wanted: Set<string>, file: PickCandidate): number {
  const head = tokens(`${file.name} ${file.digest.title ?? ''} ${file.digest.summary ?? ''}`);
  const body = tokens(
    file.digest.pages
      .slice(0, 60)
      .map((page) => `${(page.text ?? '').slice(0, 3000)} ${page.description ?? ''}`)
      .join(' '),
  );
  const inHead = share(wanted, head);
  const inBody = share(wanted, body);
  return Math.max(inHead, inBody * 0.85) + 0.15 * Math.min(inHead, inBody);
}

/** The library file the message points at, or null. */
export function pickFromLibrary<T extends PickCandidate>(message: string, files: readonly T[]): T | null {
  if (!pointsAtFiles(message) || !files.length) return null;
  const wanted = tokens(message);
  if (!wanted.size) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const file of files) {
    const value = scoreFile(wanted, file);
    if (value > bestScore) {
      best = file;
      bestScore = value;
    }
  }
  return bestScore >= MIN_SCORE ? best : null;
}
