/**
 * How MindPal's face listens: the visual "yeah", "mm", "oh!".
 *
 * Spoken acknowledgments were removed; a listener mostly acknowledges with the
 * face anyway. Two questions, answered separately so neither depends on the
 * caller's language:
 *
 *  - WHEN: from the voice itself. A stretch of speech followed by a short pause
 *    is a phrase ending in every language, which is where people nod.
 *  - WHAT: from meaning. The phrase goes to a multilingual classifier (the
 *    `/api/voice/reaction` endpoint) that answers smile, surprise, concern,
 *    curious or none. No word lists.
 *
 * This decides reactions; it never makes a sound and never touches the call.
 */
import type { FaceExpression } from './expressionCatalog.ts';

export type ReactionKind =
  | 'nod'
  | 'double_nod'
  | 'ah'
  | 'smile'
  | 'laugh'
  | 'tilt'
  | 'concern'
  | 'tender'
  | 'excited';
/** What the classifier says a phrase means. */
export type ReactionMeaning =
  | 'smile'
  | 'laugh'
  | 'surprise'
  | 'concern'
  | 'tender'
  | 'excited'
  | 'curious'
  | 'none';

export interface ListenerReaction {
  kind: ReactionKind;
  /** Wall-clock start, ms. */
  at: number;
  /** 0..1 */
  strength: number;
}

/** Speech this long before a pause makes a phrase worth acknowledging. */
export const PHRASE_MIN_SPEECH_MS = 900;
/** Silence this long after speech ends the phrase. Shorter gaps are within a word. */
export const PHRASE_PAUSE_MS = 220;
/** A phrase this long earns a double nod. */
export const DOUBLE_NOD_SPEECH_MS = 3_500;
/** A listener who nods every second looks like a bobblehead. */
export const NOD_GAP_MS = 1_300;
/** Looks (smile, concern...) change more slowly than nods. */
export const LOOK_GAP_MS = 2_500;
/** One dip of a nod: down and back up. */
export const NOD_DIP_MS = 420;

/**
 * Phrase endings from voice activity alone. Feed one frame per 20ms of mic audio;
 * returns the phrase's speech length once, at the first moment its pause is long
 * enough.
 */
export class PhraseDetector {
  private runStart = 0;
  private lastVoiced = 0;
  private emitted = true;

  frame(voiced: boolean, now: number): { speechMs: number } | null {
    if (voiced) {
      if (!this.lastVoiced || now - this.lastVoiced > PHRASE_PAUSE_MS) {
        this.runStart = now;
        this.emitted = false;
      }
      this.lastVoiced = now;
      return null;
    }
    if (this.emitted || !this.lastVoiced || now - this.lastVoiced < PHRASE_PAUSE_MS) return null;
    this.emitted = true;
    const speechMs = this.lastVoiced - this.runStart;
    return speechMs >= PHRASE_MIN_SPEECH_MS ? { speechMs } : null;
  }

  /** MindPal started talking: whatever the caller had going is not a phrase to nod at. */
  reset(): void {
    this.runStart = 0;
    this.lastVoiced = 0;
    this.emitted = true;
  }
}

export class ListenerReactor {
  private lastNodAt = Number.NEGATIVE_INFINITY;
  private lastLookAt = Number.NEGATIVE_INFINITY;

  /** A phrase ended: nod, or double-nod after a long one. */
  phraseEnd(speechMs: number, now: number): ListenerReaction | null {
    if (now - this.lastNodAt < NOD_GAP_MS) return null;
    this.lastNodAt = now;
    return {
      kind: speechMs >= DOUBLE_NOD_SPEECH_MS ? 'double_nod' : 'nod',
      at: now,
      strength: 0.45 + Math.min(0.35, speechMs / 10_000),
    };
  }

  /**
   * The classifier's reading of the phrase. While the caller is distressed only
   * concern shows: no smiling at someone who is struggling, whatever a phrase says.
   */
  meaning(label: string, now: number, distress: boolean): ListenerReaction | null {
    const kind = kindFor(label);
    if (!kind || (distress && kind !== 'concern' && kind !== 'tender')) return null;
    if (now - this.lastLookAt < LOOK_GAP_MS) return null;
    this.lastLookAt = now;
    return { kind, at: now, strength: 0.8 };
  }
}

/** The reaction for a classifier label, or null for none/unknown. */
export function kindFor(label: string): ReactionKind | null {
  switch (label) {
    case 'smile':
    case 'laugh':
    case 'concern':
    case 'tender':
    case 'excited':
      return label;
    case 'surprise':
      return 'ah';
    case 'curious':
      return 'tilt';
    default:
      return null;
  }
}

/** Head motion per reaction: dips, their length, and direction (negative lifts). */
const MOTION: Partial<Record<ReactionKind, { dips: number; dipMs: number; sign: number }>> = {
  nod: { dips: 1, dipMs: NOD_DIP_MS, sign: 1 },
  double_nod: { dips: 2, dipMs: NOD_DIP_MS * 0.8, sign: 1 },
  ah: { dips: 1, dipMs: NOD_DIP_MS, sign: -0.6 },
  // A laugh bounces: quick and small, twice.
  laugh: { dips: 2, dipMs: 260, sign: 0.55 },
  // Tenderness is one slow, deep nod.
  tender: { dips: 1, dipMs: 780, sign: 0.8 },
};

/**
 * Head motion for a reaction at `now`: 0 at rest, up to `strength` at the bottom
 * of a dip. A half-sine per dip, so it starts and ends at rest with no jump.
 */
export function nodOffset(reaction: ListenerReaction | null, now: number): number {
  const motion = reaction ? MOTION[reaction.kind] : undefined;
  if (!reaction || !motion) return 0;
  const t = now - reaction.at;
  if (t < 0 || t >= motion.dips * motion.dipMs) return 0;
  const phase = (t % motion.dipMs) / motion.dipMs;
  const second = t >= motion.dipMs ? 0.7 : 1;
  return motion.sign * second * reaction.strength * Math.sin(Math.PI * phase);
}

/** The eye look that goes with a reaction, if any. Nods are head motion only. */
export function reactionLook(
  reaction: ListenerReaction,
): { expression: FaceExpression; durationMs: number; intensity: number } | null {
  switch (reaction.kind) {
    case 'smile':
      return { expression: 'smile_eyes', durationMs: 1_400, intensity: 0.8 };
    case 'ah':
      return { expression: 'surprised', durationMs: 900, intensity: 0.65 };
    case 'tilt':
      return { expression: 'curious', durationMs: 1_500, intensity: 0.7 };
    case 'concern':
      return { expression: 'concerned', durationMs: 2_200, intensity: 0.7 };
    case 'laugh':
      return { expression: 'laugh', durationMs: 1_800, intensity: 0.95 };
    case 'tender':
      return { expression: 'soften', durationMs: 2_400, intensity: 0.75 };
    case 'excited':
      return { expression: 'excited', durationMs: 1_600, intensity: 0.9 };
    default:
      return null;
  }
}
