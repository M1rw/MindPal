/**
 * In-band risk rating reported by the Live model via the `report_risk` tool.
 *
 * Why this exists alongside the text classifier: the classifier only ever sees an
 * ASR transcript. The Live model hears the call — hesitation, crying, a voice
 * going flat, the pause before an answer. None of that survives transcription.
 * It also costs nothing and adds no latency, where a classify round trip
 * measured 778–830 ms against a 600 ms mic gate.
 *
 * What it is NOT: independent. The model generating the conversation is also
 * grading it, so a drifted or talked-around model fails at both jobs in the same
 * moment, and a tool it simply never calls is silence rather than an explicit
 * "unverified". So a low rating is not evidence the call is safe — it is the
 * absence of evidence that it is not.
 *
 * Consequence for the thresholds below: raising the floor costs a pause on
 * someone who was joking. Lowering it costs a missed escalation. The asymmetry
 * is the same one the classifier fixtures encode, so the bands match the
 * classifier's three labels exactly — one state machine, two ways in.
 */

export type RiskKind = 'self_harm' | 'physical' | 'unspecified';

export type RiskBand = 'ordinary' | 'support' | 'imminent';

export interface RiskReport {
  risk: number;
  kind: RiskKind;
  reason: string;
}

/** 3..6 keeps the call up and slows MindPal down. Maps to `stay_support`. */
export const SUPPORT_THRESHOLD = 3;
/** 7+ is the only band that can pause. Maps to `escalate_pause` + speak-first. */
export const IMMINENT_THRESHOLD = 7;

/**
 * A single high rating is a model opinion, not a verdict. Requiring the model to
 * hold that opinion across two reports costs at most a few hundred milliseconds
 * (tool calls stream during the turn) and removes the one-off misfire — the
 * failure that takes the voice away from someone mid-sentence.
 */
export const IMMINENT_CONFIRMATIONS = 2;
/** A stale high rating must not combine with a later one from a different topic. */
export const CONFIRMATION_WINDOW_MS = 45_000;

const KINDS: ReadonlySet<string> = new Set<RiskKind>(['self_harm', 'physical', 'unspecified']);

/** Parse whatever the provider actually sent. Junk is treated as no report. */
export function parseRiskArgs(args: Record<string, unknown>): RiskReport | null {
  const raw = args?.risk;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  const risk = Math.min(10, Math.max(0, value));
  const kindRaw = typeof args?.kind === 'string' ? args.kind : '';
  const kind = (KINDS.has(kindRaw) ? kindRaw : 'unspecified') as RiskKind;
  const reason = typeof args?.reason === 'string' ? args.reason.slice(0, 200) : '';
  return { risk, kind, reason };
}

export function bandFor(risk: number): RiskBand {
  if (risk >= IMMINENT_THRESHOLD) return 'imminent';
  if (risk >= SUPPORT_THRESHOLD) return 'support';
  return 'ordinary';
}

export interface RiskDecision {
  band: RiskBand;
  /** True only when an imminent band has been confirmed and may pause the call. */
  pause: boolean;
  /** True when the call should enter stay-support. */
  support: boolean;
  confirmations: number;
  reason: string;
}

/**
 * Tracks consecutive imminent reports. Deliberately asymmetric: a single
 * ordinary/support rating clears the streak, because a model that has changed
 * its mind downward should be believed immediately — the expensive error is
 * pausing, not continuing.
 */
export class RiskLatch {
  private imminentCount = 0;
  private lastImminentAt = 0;
  private peak = 0;

  get peakRisk(): number {
    return this.peak;
  }

  get pendingConfirmations(): number {
    return this.imminentCount;
  }

  note(report: RiskReport, now = Date.now()): RiskDecision {
    this.peak = Math.max(this.peak, report.risk);
    const band = bandFor(report.risk);

    if (band !== 'imminent') {
      this.imminentCount = 0;
      this.lastImminentAt = 0;
      return {
        band,
        pause: false,
        support: band === 'support',
        confirmations: 0,
        reason: report.reason,
      };
    }

    // A high rating from a topic 45s ago should not combine with this one.
    if (this.lastImminentAt && now - this.lastImminentAt > CONFIRMATION_WINDOW_MS) {
      this.imminentCount = 0;
    }
    this.imminentCount += 1;
    this.lastImminentAt = now;

    return {
      band,
      pause: this.imminentCount >= IMMINENT_CONFIRMATIONS,
      // Below the confirmation count, an imminent report still slows the call
      // down rather than doing nothing while it waits for a second opinion.
      support: this.imminentCount < IMMINENT_CONFIRMATIONS,
      confirmations: this.imminentCount,
      reason: report.reason,
    };
  }

  reset(): void {
    this.imminentCount = 0;
    this.lastImminentAt = 0;
  }
}

/**
 * Note handed to the model when it rates 7+, so the spoken beat before the pause
 * is about the person rather than about the product. Mirrors what the server
 * sends on a classifier escalation, so both routes sound the same.
 */
/**
 * What MindPal is told when someone describes danger happening now.
 *
 * There is no crisis pause: the call is never frozen or ended on the caller.
 * Instead MindPal stays on the line and names immediate help out loud, once,
 * plainly, without pushing them off the call.
 */
export function imminentStayNote(kind: RiskKind): string {
  const situation =
    kind === 'physical'
      ? 'They described immediate physical danger.'
      : kind === 'self_harm'
        ? 'They described harm to themselves that is happening now.'
        : 'They described danger that sounds like it is happening now.';
  return [
    '[[MindPal]] Application note, not the caller\'s words. Do not read this note aloud.',
    situation,
    'Stay on this call with them. Say one short warm sentence about what they just said',
    'and tell them you are staying with them.',
    'Tell them plainly that they can call or text 988, or call local emergency services,',
    'right now, and that they can do that while still talking to you.',
    'Do not end, pause, or leave the call. Do not lecture. Never give methods, plans, or means.',
  ].join(' ');
}
