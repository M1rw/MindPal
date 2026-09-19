/**
 * Safety hold for the live face. Not user-emotion detection and not a clinical signal:
 * once anything looks like distress, MindPal's own face stays attentive for a hold window
 * instead of being recomputed from whatever fragment of transcript arrived last.
 */

import { isQuietDistress, type ProsodySnapshot } from './prosody.ts';

/** Classifier stay-support / acoustic hold. Transcript words do not start this clock. */
export const DISTRESS_HOLD_MS = 45_000;
/** Acoustic evidence is weaker, so it holds only long enough to stop frame-level flicker. */
export const ACOUSTIC_DISTRESS_HOLD_MS = 8_000;

/**
 * Flat-affect monotone and quiet-turn speech are both reasons to stay warm and awake.
 * They are descriptors of the captured audio, never a claim about the person.
 */
export function isAcousticDistress(prosody: ProsodySnapshot | null | undefined): boolean {
  if (!prosody) return false;
  if (prosody.state === 'flattening') return true;
  return isQuietDistress(prosody);
}

export class DistressLatch {
  private heldUntil = 0;
  private crisisLatched = false;

  /**
   * Transcript words are not a freeze signal. The Gemini classifier is the
   * stay/pause authority. This method exists so the session can pass captions
   * through without a keyword latch driving the pause UI.
   */
  noteText(_text: string, now = Date.now()): boolean {
    void _text;
    return this.active(now);
  }

  noteProsody(prosody: ProsodySnapshot | null | undefined, now = Date.now()): boolean {
    if (isAcousticDistress(prosody)) {
      this.heldUntil = Math.max(this.heldUntil, now + ACOUSTIC_DISTRESS_HOLD_MS);
    }
    return this.active(now);
  }

  noteCrisis(): void {
    this.crisisLatched = true;
  }

  /** Stay-support: keep the concerned face without the hung-up freeze pose. */
  noteSupport(now = Date.now()): boolean {
    this.heldUntil = Math.max(this.heldUntil, now + DISTRESS_HOLD_MS);
    return this.active(now);
  }

  active(now = Date.now()): boolean {
    return this.crisisLatched || now < this.heldUntil;
  }

  get crisis(): boolean {
    return this.crisisLatched;
  }

  holdRemainingMs(now = Date.now()): number {
    if (this.crisisLatched) return DISTRESS_HOLD_MS;
    return Math.max(0, this.heldUntil - now);
  }

  reset(): void {
    this.heldUntil = 0;
    this.crisisLatched = false;
  }
}
