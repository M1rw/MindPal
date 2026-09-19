/**
 * One rule: a caller who finished talking gets an answer.
 *
 * Gemini answers nearly every turn by itself. The exception is when it chooses
 * silence: it opens a generation carrying only `<ctrl46>` and holds it for up to
 * ten seconds, or closes the generation empty. For those two cases, and only
 * those, MindPal is asked to reply once. A slow but real reply is never nudged,
 * because a nudge on top of it produces two answers.
 */

/**
 * A generation of control tokens only, open this long, is Gemini choosing silence.
 * Counted from the later of the caller's pause and the generation opening, so the
 * caller has already waited ~1.2s by then. In recorded calls such a generation
 * never turned into words by itself.
 */
export const SILENT_GENERATION_MS = 1_500;
/** After an empty generation closes, give a real one this long to start first. */
export const EMPTY_GENERATION_GRACE_MS = 900;

export const REPLY_NUDGE_NOTE = [
  '[[MindPal]] Application note, not their words. Do not read this note aloud.',
  'The person you are talking to has finished speaking and is waiting for you.',
  'Reply now, to them alone, in their language, in one natural turn.',
].join(' ');

export class ReplyGuard {
  /** When the owed reply became owed; null when nothing is owed. */
  private waitingSince: number | null = null;
  private nudged = false;
  private generationOpenedAt: number | null = null;
  private generationHasWords = false;
  private emptyClosedAt: number | null = null;

  /** The caller finished a turn: a reply is now owed. */
  userTurnEnded(now: number): void {
    this.waitingSince = now;
    this.nudged = false;
    this.emptyClosedAt = null;
  }

  /** The caller carried on, or the reply began: nothing is owed right now. */
  settle(): void {
    this.waitingSince = null;
    this.emptyClosedAt = null;
  }

  generationDelta(now: number, hasWords: boolean): void {
    if (this.generationOpenedAt === null) this.generationOpenedAt = now;
    if (hasWords) {
      this.generationHasWords = true;
      this.settle();
    }
  }

  generationComplete(now: number): void {
    if (this.waitingSince !== null && !this.generationHasWords) this.emptyClosedAt = now;
    this.generationOpenedAt = null;
    this.generationHasWords = false;
  }

  /** Truthy exactly once per owed reply, when the nudge should go out. */
  poll(now: number): false | 'silent_generation' | 'empty_generation' {
    if (this.waitingSince === null || this.nudged) return false;
    if (this.emptyClosedAt !== null && now - this.emptyClosedAt >= EMPTY_GENERATION_GRACE_MS) {
      this.nudged = true;
      return 'empty_generation';
    }
    if (this.generationOpenedAt !== null && !this.generationHasWords) {
      const silentSince = Math.max(this.generationOpenedAt, this.waitingSince);
      if (now - silentSince >= SILENT_GENERATION_MS) {
        this.nudged = true;
        return 'silent_generation';
      }
    }
    return false;
  }

  get owed(): boolean {
    return this.waitingSince !== null;
  }
}
