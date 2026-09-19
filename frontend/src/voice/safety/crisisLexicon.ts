/**
 * Client-side crisis lexicon. Not the live-voice freeze authority.
 *
 * Live duplex freezes on the Gemini JSON classifier via the control plane
 * (`voice.transcript.sync` → `stay_support` or `escalate_pause`). This file remains a fold of the
 * shared ASR corpus used by tests and by HTTP chat's keyword SafetyService mirror.
 * Do not wire `crisisEvidence` back into `LiveVoiceSession`.
 */

const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;
const ARABIC_FOLD: Record<string, string> = {
  '\u0623': '\u0627',
  '\u0625': '\u0627',
  '\u0622': '\u0627',
  '\u0671': '\u0627',
  '\u0649': '\u064A',
  '\u0626': '\u064A',
  '\u0624': '\u0648',
  '\u0629': '\u0647',
};
const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;

/** Fold ASR output into the same shape the backend patterns are written against. */
export function normalizeForCrisis(text: string): string {
  if (!text) return '';
  let folded = text.normalize('NFKC').toLowerCase().replace(ARABIC_DIACRITICS, '');
  folded = folded.replace(/[\u0623\u0625\u0622\u0671\u0649\u0626\u0624\u0629]/g, (ch) => ARABIC_FOLD[ch] || ch);
  folded = folded.replace(/['\u2018\u2019`]/g, '');
  return folded.replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}

const SELF = 'my\\s*self';
const NEG = '(?:dont|do\\s*not|doesnt|cant|can\\s*not|wont|will\\s*not)';
/** Arabic has no usable word boundary: "نفسي" (myself) prefixes "نفسيتي" (my mood). */
const AR_END = '(?![\\u0621-\\u064A])';

const CRISIS_PATTERNS: string[] = [
  `\\bkill(?:ing|ed)?\\s*${SELF}\\b`,
  `\\b(?:off|offing)\\s*${SELF}\\b`,
  `\\bhurt(?:ing)?\\s*${SELF}\\b`,
  `\\bharm(?:ing)?\\s*${SELF}\\b`,
  `\\bcut(?:ting)?\\s*${SELF}\\b`,
  `\\bhang(?:ing)?\\s*${SELF}\\b`,
  `\\bstab(?:bing)?\\s*${SELF}\\b`,
  '\\bself\\s*harm(?:ing|ed)?\\b',
  '\\bsl(?:it|itting)\\s*my\\s*wrists?\\b',
  '\\bcut(?:ting)?\\s*my\\s*wrists?\\b',
  '\\boverdos(?:e|ed|ing)\\b',
  '\\bsuicid(?:e|al)\\b',
  '\\bend(?:ing)?\\s*my\\s*life\\b',
  '\\bend(?:ing)?\\s*it\\s*all\\b',
  '\\btak(?:e|ing)\\s*my\\s*own\\s*life\\b',
  '\\b(?:want(?:ed|ing)?\\s*to|wanna|wana)\\s*die\\b',
  '\\bwish\\s*(?:i|id)\\s*(?:was|were|wasnt|am)\\s*dead\\b',
  '\\bwish\\s*i\\s*(?:could|would)\\s*die\\b',
  '\\b(?:better\\s*off|rather\\s*be|want\\s*to\\s*be)\\s*dead\\b',
  `\\b${NEG}\\s*want\\s*to\\s*(?:live|be\\s*alive|wake\\s*up\\s*(?:again|tomorrow))\\b`,
  `\\b${NEG}\\s*want\\s*to\\s*be\\s*here\\s*any\\s*more\\b`,
  '\\bno\\s*(?:reason|point)\\s*(?:to|in|of)?\\s*liv(?:e|ing)\\b',
  '\\bno\\s*point\\s*being\\s*(?:here|alive)\\b',
  '\u0627\u0646\u062A\u062D\u0627\u0631',
  '\u0627\u0646\u062A\u062D\u0631',
  `\u0642\u062A\u0644\\s*(?:\u0646\u0641\u0633\u064A|\u062D\u0627\u0644\u064A)${AR_END}`,
  `\u0634\u0646\u0642\\s*(?:\u0646\u0641\u0633\u064A|\u062D\u0627\u0644\u064A)${AR_END}`,
  `\u0627\u064A\u0630\u0627\u0621\\s*(?:\u0646\u0641\u0633\u064A|\u0627\u0644\u0646\u0641\u0633)${AR_END}`,
  `(?:\u0627\u0630\u064A|\u0627\u0648\u0630\u064A|\u0627\u062C\u0631\u062D|\u062C\u0631\u062D)\\s*(?:\u0646\u0641\u0633\u064A|\u062D\u0627\u0644\u064A)${AR_END}`,
  '\u062C\u0631\u0639\u0647\\s*\u0632\u0627\u064A\u062F\u0647',
  `(?:\u0627\u0646\u0647\u064A|\u0627\u0646\u0647\u0627\u0621|\u0627\u062E\u0644\u0635\\s*\u0645\u0646)\\s*\u062D\u064A\u0627\u062A\u064A${AR_END}`,
  `(?:\u0627\u0628\u064A|\u0628\u062F\u064A|\u0639\u0627\u064A\u0632|\u0639\u0627\u0648\u0632|\u0627\u0631\u064A\u062F|\u0646\u0641\u0633\u064A|\u0648\u062F\u064A|\u0628\u063A\u064A\u062A|\u062D\u0627\u0628)\\s*(?:\u0627\u0646\\s*)?\u0627\u0645\u0648\u062A${AR_END}`,
  `(?:\u0645\u0627\\s*\u0628\u062F\u064A|\u0645\u0627\u0628\u062F\u064A|\u0645\u0634\\s*\u0639\u0627\u064A\u0632|\u0645\u0634\\s*\u0639\u0627\u0648\u0632|\u0644\u0627\\s*\u0627\u0631\u064A\u062F|\u0645\u0627\\s*\u0627\u0628\u064A|\u0645\u0627\\s*\u0627\u0631\u064A\u062F)\\s*(?:\u0627\u0646\\s*)?\u0627\u0639\u064A\u0634${AR_END}`,
];

/** Idioms that contain a crisis phrase without being a disclosure. */
const BENIGN_PATTERNS: string[] = [
  `\\bkill(?:ing)?\\s*${SELF}\\s*laughing\\b`,
  '\\b(?:want(?:ed)?\\s*to|wanna)\\s*die\\s*(?:laughing|of\\s*(?:laughter|embarrassment|shame))\\b',
  '\\boverdos(?:e|ed|ing)\\s*(?:on|of)\\s*(?:caffeine|coffee|sugar|chocolate|candy|carbs|cake|vitamins?)\\b',
  '\\bsuicide\\s*(?:and\\s*crisis\\s*)?(?:lifeline|hotline|help\\s*line|helpline|prevention|squad)\\b',
  '\\bnational\\s*suicide\\b',
  '\\bsuicide\\s*prevention\\b',
  '\u062E\u0637\\s*(?:\u0627\u0644\u062F\u0639\u0645|\u0627\u0644\u0645\u0633\u0627\u0639\u062F\u0647|\u0627\u0644\u0637\u0648\u0627\u0631\u0626)',
];

const CRISIS_REGEX = new RegExp(CRISIS_PATTERNS.join('|'), 'gu');
const BENIGN_REGEX = new RegExp(BENIGN_PATTERNS.join('|'), 'gu');

/** The matched phrase from the normalized transcript, or null. */
export function crisisEvidence(text: string): string | null {
  const normalized = normalizeForCrisis(text);
  if (!normalized) return null;
  const benign: Array<[number, number]> = [];
  BENIGN_REGEX.lastIndex = 0;
  for (let m = BENIGN_REGEX.exec(normalized); m; m = BENIGN_REGEX.exec(normalized)) {
    benign.push([m.index, m.index + m[0].length]);
  }
  CRISIS_REGEX.lastIndex = 0;
  for (let m = CRISIS_REGEX.exec(normalized); m; m = CRISIS_REGEX.exec(normalized)) {
    const start = m.index;
    const end = start + m[0].length;
    if (benign.some(([bStart, bEnd]) => bStart <= start && end <= bEnd)) continue;
    return m[0];
  }
  return null;
}

export function isCrisisSpeech(text: string): boolean {
  return crisisEvidence(text) !== null;
}
