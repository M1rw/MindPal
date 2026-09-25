/**
 * Is the caller still there?
 *
 * A live call used to sit open in silence until the 30-minute limit: no
 * check-in, no warning, no goodbye. This watches the quiet and escalates the
 * way a person on the phone would: check in, then say you'll let them go, then
 * a warm goodbye. Muted callers get longer, because they may just be listening.
 *
 * Pure and clock-driven (the controller passes `now`), so it is tested with the
 * fake clock. Quiet is only counted while nothing is happening: the controller
 * reports "busy" whenever the model is speaking, a reply is on its way, the
 * socket is being replaced, or MindPal is staying with someone in crisis. It
 * never hangs up on a safety hold.
 */

export type IdleStage = 'active' | 'check_in' | 'warn' | 'end';

export interface IdleTimings {
  checkInMs: number;
  warnMs: number;
  endMs: number;
}

export interface IdleConfig {
  open: IdleTimings;
  muted: IdleTimings;
}

/** Unmuted: 15s / 40s / 60s ("quick", chosen by the product owner). Muted: 1 / 2 / 3 minutes. */
export const DEFAULT_IDLE: IdleConfig = {
  open: { checkInMs: 15_000, warnMs: 40_000, endMs: 60_000 },
  muted: { checkInMs: 60_000, warnMs: 120_000, endMs: 180_000 },
};

const LABEL = '[[MindPal]] Application note, not their words. Do not read this note aloud.';

/**
 * Ways to check in. The note used to quote "still with me?" as its example, so
 * the model said exactly that every time. Now each check-in gets a different
 * angle, and the model is told to make the words its own.
 */
export const CHECK_IN_ANGLES = [
  'pick the thread back up: mention the last thing you two were talking about and gently ask if they are still there',
  'make a light, warm remark about the quiet, as a friend would, and see if they are around',
  'ask, lightly, whether something pulled them away',
  'give them room: say there is no rush and you are here whenever they want to carry on',
  'wonder aloud, playfully, whether they are still thinking about what you last talked about',
] as const;

const WARN_ANGLES = [
  'say you will let them go in a bit if they have stepped away, and that saying anything keeps the call going',
  'say you will hang up soon so they are not left with an open line, unless they say something',
  'say you will wrap up shortly if they are busy, and that they can pick this back up anytime by speaking',
] as const;

const FRESH = 'Say it in your own fresh words (no stock phrase, and not a line you have already used on this call).';

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

export function idleNote(stage: Exclude<IdleStage, 'active'>, muted: boolean, random: () => number = Math.random): string {
  const quiet = muted
    ? 'The caller has been quiet for a while and their mic is muted, so they may just be listening.'
    : 'The caller has been quiet for a little while.';
  if (stage === 'check_in') {
    return `${LABEL} ${quiet} Check in once, lightly and naturally, in their language: ${pick(CHECK_IN_ANGLES, random)}. ${FRESH} One short line, then wait.`;
  }
  if (stage === 'warn') {
    return `${LABEL} ${quiet} They still haven't answered. In one short, warm line in their language, ${pick(WARN_ANGLES, random)}. ${FRESH}`;
  }
  return `${LABEL} ${quiet} They seem to have stepped away. Say a short, warm goodbye in their language, tied to what you talked about if it fits, and that they can call back anytime. ${FRESH} The call ends after this line.`;
}

const NEXT: Record<Exclude<IdleStage, 'end'>, Exclude<IdleStage, 'active'>> = {
  active: 'check_in',
  check_in: 'warn',
  warn: 'end',
};

export class IdleWatch {
  private quietSince = 0;
  private stage: IdleStage = 'active';
  private muted = false;
  private config: IdleConfig;

  constructor(config: IdleConfig = DEFAULT_IDLE) {
    this.config = config;
  }

  configure(config: Partial<IdleConfig> | undefined): void {
    if (!config) return;
    this.config = {
      open: { ...this.config.open, ...(config.open ?? {}) },
      muted: { ...this.config.muted, ...(config.muted ?? {}) },
    };
  }

  /** The caller or the call did something: speech, unmute, a tap on "I'm here". */
  activity(now: number): void {
    this.quietSince = now;
    this.stage = 'active';
  }

  noteMuted(muted: boolean, now: number): void {
    this.muted = muted;
    this.activity(now);
  }

  get current(): IdleStage {
    return this.stage;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Next escalation, returned once when its threshold is crossed; null otherwise.
   * `busy` pauses the count (and restarts it when things go quiet again).
   */
  poll(now: number, busy: boolean): Exclude<IdleStage, 'active'> | null {
    // Busy (the model is saying its check-in, a reply is coming...) restarts the
    // quiet clock but keeps the stage, so each step is measured from the end of
    // the previous one. Only real caller activity goes back to 'active'.
    if (!this.quietSince || busy) {
      this.quietSince = now;
      return null;
    }
    const quiet = now - this.quietSince;
    const wait = this.waitFor(this.stage);
    if (wait === null || quiet < wait) return null;
    if (this.stage === 'end') return null;
    const next = NEXT[this.stage];
    this.stage = next;
    this.quietSince = now;
    return next;
  }

  /** Milliseconds until the call ends for inactivity, once a warning is out; else null. */
  remainingMs(now: number): number | null {
    if (this.stage !== 'warn' || !this.quietSince) return null;
    const wait = this.waitFor('warn') ?? 0;
    return Math.max(0, wait - (now - this.quietSince));
  }

  /** Quiet needed before the step after `stage`; the totals match the configured 15/40/60s. */
  private waitFor(stage: IdleStage): number | null {
    const t = this.muted ? this.config.muted : this.config.open;
    if (stage === 'active') return t.checkInMs;
    if (stage === 'check_in') return Math.max(1_000, t.warnMs - t.checkInMs);
    if (stage === 'warn') return Math.max(1_000, t.endMs - t.warnMs);
    return null;
  }
}
