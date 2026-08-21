function clampOffset(value, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(max, Math.floor(numeric)));
}

/**
 * Find the next spoken range in a complete assistant transcript. The cursor is
 * monotonic so repeated cumulative transcript updates cannot move the
 * highlight backward to an earlier occurrence of the same word.
 */
export function findCaptionHighlightRange(sourceText, segmentText, fromOffset = 0) {
  const source = String(sourceText || "");
  const segment = String(segmentText || "").trim();
  const from = clampOffset(fromOffset, source.length);
  if (!source || !segment || from >= source.length) return null;

  let start = source.indexOf(segment, from);
  if (start < 0) {
    const token = segment.split(/\s+/).find(Boolean) || segment;
    start = source.indexOf(token, from);
  }
  if (start < 0) return null;
  return Object.freeze({
    start,
    end: Math.min(source.length, start + segment.length),
  });
}

export function normalizeCaptionHighlightRange(sourceText, start = 0, end = 0) {
  const source = String(sourceText || "");
  const safeStart = clampOffset(start, source.length);
  const safeEnd = Math.max(safeStart, clampOffset(end, source.length));
  return Object.freeze({ start: safeStart, end: safeEnd });
}
