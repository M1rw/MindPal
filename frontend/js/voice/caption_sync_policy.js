// Deliberately conservative: caption text must not outrun natural spoken audio.
export const CAPTION_CHARS_PER_SECOND = 16;
export const CAPTION_MIN_RELEASE_SECONDS = 0.18;
export const CAPTION_MAX_RELEASE_SECONDS = 1.8;
export const CAPTION_MAX_SEGMENT_CHARS = 30;

export function mergeIncrementalTranscript(existing, chunk) {
  const previous = String(existing || "");
  const next = String(chunk || "");
  if (!previous) return next;
  if (!next || previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  if (/\s$/.test(previous) || /^\s/.test(next) || /^[,.;:!?،؟]/.test(next)) return previous + next;
  return `${previous} ${next}`;
}

export function extractNovelTranscript(existing, chunk) {
  const merged = mergeIncrementalTranscript(existing, chunk);
  if (!merged || merged === existing) return { merged, delta: "" };
  if (merged.startsWith(existing)) return { merged, delta: merged.slice(existing.length) };
  return { merged, delta: String(chunk || "") };
}

export function splitCaptionForPlayback(text, maxChars = CAPTION_MAX_SEGMENT_CHARS) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const segments = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      segments.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function getCaptionReleaseSeconds(segment) {
  const chars = String(segment || "").trim().length;
  return Math.min(
    CAPTION_MAX_RELEASE_SECONDS,
    Math.max(CAPTION_MIN_RELEASE_SECONDS, chars / CAPTION_CHARS_PER_SECOND),
  );
}

export function planPacedCaptionSegments({
  text,
  audioStartTime,
  nextCaptionTime = 0,
  now = 0,
} = {}) {
  const segments = splitCaptionForPlayback(text);
  let cursor = Math.max(Number(audioStartTime) || now, Number(nextCaptionTime) || 0, now);
  return segments.map((segment) => {
    const startTime = cursor;
    const duration = getCaptionReleaseSeconds(segment);
    cursor += duration;
    return { text: segment, startTime, duration };
  });
}
