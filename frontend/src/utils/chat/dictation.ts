/** Pure helpers for composer dictation (hooks/chat/useChatInputDictation.ts). */

/** A single voice note is capped well under the server's size limit. */
export const MAX_RECORDING_MS = 3 * 60 * 1000;

const BROWSER_LANG: Record<string, string> = { en: 'en-US', ar: 'ar-SA', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };

/** The one language browser recognition must be told: the setting, else the browser's own. */
export function browserDictationLang(voiceLanguage: string | undefined, navigatorLang: string | undefined): string {
  const chosen = (voiceLanguage || 'auto').toLowerCase();
  if (chosen !== 'auto') return BROWSER_LANG[chosen] ?? chosen;
  return navigatorLang || 'en-US';
}

/** The first container this browser can record (Chrome/Android: webm/opus; Safari/iOS: mp4). */
export function recordingMimeType(isSupported: (type: string) => boolean): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac']) {
    if (isSupported(type)) return type;
  }
  return '';
}

const SPOKEN_KEY = 'mindpal.dictation.spoken';

const isArabicLetter = (code: number) => (code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f);

/** localStorage, or undefined where it is blocked (private mode, sandboxed previews). */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Languages this person has dictated in, as their base code ("ar"), kept on the device. */
function spokenBefore(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const saved = JSON.parse(storage?.getItem(SPOKEN_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((code): code is string => typeof code === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember the languages a transcript was written in (by script: Arabic letters mean Arabic). */
export function rememberSpoken(text: string, language: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): void {
  const found = new Set(spokenBefore(storage));
  if ([...text].some((ch) => isArabicLetter(ch.codePointAt(0) ?? 0))) found.add('ar');
  const named = (language || '').toLowerCase();
  if (named && named !== 'english' && named !== 'arabic' && /^[a-z-]{2,12}$/.test(named)) found.add(named);
  try {
    storage?.setItem(SPOKEN_KEY, JSON.stringify([...found].slice(0, 6)));
  } catch {
    // Private mode or full storage: the hints just start empty next time.
  }
}

/**
 * Who is speaking, for the server's routing (X-Dictation-Languages): the voice
 * setting, the browser's languages, and languages dictated before. Someone who
 * speaks more than English gets the model that follows a switch mid-note;
 * Whisper alone keeps only the language it heard first.
 */
export function dictationLanguageHints(
  voiceLanguage: string | undefined,
  navigatorLangs: readonly string[] | undefined,
  storage: Pick<Storage, 'getItem'> | undefined,
): string[] {
  const hints: string[] = [];
  const add = (tag: string | undefined) => {
    const clean = (tag || '').trim().toLowerCase();
    if (/^[a-z]{2,12}(-[a-z0-9]{1,8})?$/.test(clean) && !hints.includes(clean)) hints.push(clean);
  };
  if (voiceLanguage && voiceLanguage.toLowerCase() !== 'auto') add(voiceLanguage);
  (navigatorLangs ?? []).slice(0, 4).forEach(add);
  spokenBefore(storage).forEach(add);
  return hints.slice(0, 8);
}
