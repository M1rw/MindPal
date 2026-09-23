/**
 * Where MindPal's words fall on its audio.
 *
 * Text and audio stream in separately, and neither order can be relied on: a
 * transcript piece can arrive before the audio it describes or after it. So
 * the two are tracked separately and joined by proportion:
 *
 *  - every audio chunk is placed on the wall clock where it will actually play
 *    (it ends when the playback queue does, right after it is queued);
 *  - character i of C known characters sits at (i / C) of the D milliseconds
 *    of known audio.
 *
 * The mapping corrects itself as either side catches up and is exact once the
 * turn is complete. Callers resolve times when they need them (a look is placed
 * when it is due, not when its text was classified) so they always use the
 * latest mapping.
 *
 * This replaced a characters-times-65ms guess anchored on each sentence's end.
 * That guess drifted by a second or more over a long reply, so the face reacted
 * early to short sentences and late to long ones, and the error grew until the
 * reply finished. The face and the live caption now read the same timeline, so
 * the look on the face and the words shown as spoken match what can be heard.
 */

interface AudioPiece {
  /** Offset of this piece within the turn's audio, ms. */
  offset: number;
  /** Wall clock when it starts and ends playing. */
  start: number;
  end: number;
}

export class SpeechTimeline {
  private pieces: AudioPiece[] = [];
  private audioMs = 0;
  private chars = 0;
  /**
   * Highest progress reported this turn. The proportional estimate can move
   * backwards when audio outruns its transcript (more audio, same text), which
   * dimmed words that were already shown as spoken.
   */
  private shownChars = 0;

  /** A chunk of `ms` audio was just queued; the queue now holds `queuedMs`. */
  audio(ms: number, now: number, queuedMs: number): void {
    if (ms <= 0) return;
    const last = this.pieces[this.pieces.length - 1];
    const queueEnd = now + Math.max(ms, queuedMs);
    // Contiguous with the previous chunk unless the queue ran dry in between.
    const start = Math.max(last ? last.end : 0, now, queueEnd - ms);
    this.pieces.push({ offset: this.audioMs, start, end: start + ms });
    this.audioMs += ms;
  }

  /** Characters of transcript added. */
  text(addedChars: number): void {
    if (addedChars > 0) this.chars += addedChars;
  }

  /** Wall-clock moment the character at `index` is heard; Infinity before any audio. */
  timeAt(index: number): number {
    if (!this.pieces.length || !this.chars) return Number.POSITIVE_INFINITY;
    const i = Math.max(0, Math.min(index, this.chars));
    return this.wallAt((i / this.chars) * this.audioMs);
  }

  /** How many characters have been heard by `now`. Never decreases within a turn. */
  spokenChars(now: number): number {
    if (!this.audioMs || !this.chars) return this.shownChars;
    let heard = 0;
    for (const piece of this.pieces) {
      if (now <= piece.start) break;
      heard += Math.min(now, piece.end) - piece.start;
    }
    const estimate = Math.min(this.chars, Math.floor((heard / this.audioMs) * this.chars));
    this.shownChars = Math.max(this.shownChars, estimate);
    return this.shownChars;
  }

  /** Wall clock the last queued audio finishes. */
  endsAt(): number {
    return this.pieces.length ? this.pieces[this.pieces.length - 1].end : 0;
  }

  get length(): number {
    return this.chars;
  }

  get hasAudio(): boolean {
    return this.audioMs > 0;
  }

  reset(): void {
    this.pieces = [];
    this.audioMs = 0;
    this.chars = 0;
    this.shownChars = 0;
  }

  private wallAt(offset: number): number {
    for (const piece of this.pieces) {
      const dur = piece.end - piece.start;
      if (offset <= piece.offset + dur) return piece.start + Math.max(0, offset - piece.offset);
    }
    return this.endsAt();
  }
}

/** Round the heard position up to the end of the word in progress, so a word is never split in two colours. */
export function wordBoundary(text: string, chars: number): number {
  const at = Math.max(0, Math.min(chars, text.length));
  if (at === 0 || at === text.length) return at;
  const next = text.slice(at).search(/\s/);
  return next < 0 ? text.length : at + next;
}
