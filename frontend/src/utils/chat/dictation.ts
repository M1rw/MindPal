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
