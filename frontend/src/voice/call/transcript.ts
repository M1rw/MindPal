/**
 * What was said on the call, turn by turn.
 *
 * Gemini sends transcription as deltas: the caller's words (`inputTranscription`)
 * and MindPal's words (`outputTranscription`). This keeps the utterance in
 * progress on each side, hands back a finished turn exactly once, and keeps a
 * full ledger for the recap. Pure: no timers, no callbacks.
 */
import { cleanCaption, mergeLiveTranscript, stripControlTokens } from '../session/caption.ts';

/** What the safety classifier sees: recent caller speech, not the whole call. */
export const SAFETY_WINDOW_CHARS = 600;
/** Full-call ledger for the recap and the trace. */
export const LEDGER_CHARS = 24_000;

/**
 * Everything shown or committed goes through here. A marker can arrive split
 * across deltas (`<no` + `ise>`), so cleaning each delta alone is not enough.
 */
function squash(text: string): string {
  return cleanCaption(text);
}

/** Append a finished turn, keeping only the last `limit` characters on a word boundary. */
export function appendBounded(buffer: string, turn: string, limit: number): string {
  const next = squash(turn);
  if (!next) return buffer;
  const merged = buffer ? `${buffer} ${next}` : next;
  if (merged.length <= limit) return merged;
  const tail = merged.slice(merged.length - limit);
  const cut = tail.indexOf(' ');
  return cut > 0 ? tail.slice(cut + 1) : tail;
}

export class CallTranscript {
  private userTurn = '';
  private modelTurn = '';
  private modelHeard = false;
  private userLedger = '';
  private modelLedger = '';

  /**
   * A caller delta. Returns the live caption for this utterance, or null when
   * the delta was only an ASR marker (`<noise>`, `<ctrl46>`) and nothing was said.
   */
  userDelta(raw: string): string | null {
    const text = stripControlTokens(raw);
    if (!text.trim()) return null;
    this.userTurn = mergeLiveTranscript(this.userTurn, text);
    return squash(this.userTurn);
  }

  get currentUser(): string {
    return squash(this.userTurn);
  }

  /** Close the caller's utterance. Returns it, or '' if there was nothing. */
  takeUserTurn(): string {
    const turn = squash(this.userTurn);
    this.userTurn = '';
    if (turn) this.userLedger = appendBounded(this.userLedger, turn, LEDGER_CHARS);
    return turn;
  }

  /** A MindPal delta. `hasWords` is false for a bare control token. */
  modelDelta(raw: string): { caption: string; hasWords: boolean } {
    const hasWords = Boolean(stripControlTokens(raw).trim());
    this.modelTurn = mergeLiveTranscript(this.modelTurn, raw);
    return { caption: squash(this.modelTurn), hasWords };
  }

  get currentModel(): string {
    return squash(this.modelTurn);
  }

  /** MindPal's audio for the current turn actually reached the speaker. */
  noteModelAudio(): void {
    this.modelHeard = true;
  }

  get modelWasHeard(): boolean {
    return this.modelHeard;
  }

  /**
   * Close MindPal's turn. Returns what was said out loud, or '' if nothing was.
   *
   * Text that never became audio is dropped: Gemini sometimes starts a reply,
   * abandons it, and generates the real one later. Keeping the abandoned text
   * showed MindPal "answering twice".
   */
  takeModelTurn(): string {
    const turn = squash(this.modelTurn);
    const heard = this.modelHeard;
    this.modelTurn = '';
    this.modelHeard = false;
    if (!turn || !heard) return '';
    this.modelLedger = appendBounded(this.modelLedger, turn, LEDGER_CHARS);
    return turn;
  }

  /** Recent caller speech, including the utterance in progress. */
  safetyWindow(): string {
    const current = this.currentUser;
    const all = current ? appendBounded(this.userLedger, current, LEDGER_CHARS) : this.userLedger;
    return appendBounded('', all, SAFETY_WINDOW_CHARS);
  }

  /** MindPal's current turn, or its last finished one. */
  recentModel(): string {
    const current = this.currentModel;
    return current || appendBounded('', this.modelLedger, SAFETY_WINDOW_CHARS);
  }

  get userText(): string {
    const current = this.currentUser;
    return current ? appendBounded(this.userLedger, current, LEDGER_CHARS) : this.userLedger;
  }

  get modelText(): string {
    return this.modelLedger;
  }
}
