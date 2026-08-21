const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu;

export function tokenizeCaptionWords(sourceText) {
  const source = String(sourceText || "");
  return Array.from(source.matchAll(WORD_PATTERN), (match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export function estimateCaptionDurationMs(sourceText, { wordsPerMinute = 145 } = {}) {
  const words = tokenizeCaptionWords(sourceText);
  if (!words.length) return 0;
  return Math.max(850, Math.round(words.length * (60_000 / wordsPerMinute)));
}

/**
 * Map continuous playback progress to one active word. The returned range is
 * monotonic for a monotonic progress value and does not depend on new network
 * transcript packets arriving at the same moment as the audio.
 */
export function getCaptionWordAtProgress(sourceText, progress = 0) {
  const source = String(sourceText || "");
  const words = tokenizeCaptionWords(source);
  if (!words.length) return null;
  const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
  const weights = words.map((word) => Math.max(1, word.text.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let target = safeProgress * totalWeight;
  let cursor = 0;
  for (let index = 0; index < words.length; index += 1) {
    const next = cursor + weights[index];
    if (target < next || index === words.length - 1) {
      const word = words[index];
      return Object.freeze({
        text: word.text,
        start: word.start,
        end: word.end,
        index,
        progress: Math.max(0, Math.min(1, (target - cursor) / weights[index])),
        wordCount: words.length,
      });
    }
    cursor = next;
  }
  return null;
}
