/**
 * The call's safety path, in one place.
 *
 * Two ways in, one outcome:
 *  - the server classifier, fed a transcript sync at the end of every caller
 *    turn and on a heartbeat;
 *  - the Live model's own `report_risk` tool call.
 * Either can move the call into support (MindPal slows down and stays present)
 * or name immediate help out loud once (imminent). Neither ends the call.
 * Support is never stepped back down within a call.
 */
import { isEscalateAction, shouldSpeakFirst, STAY_SUPPORT_NOTE } from '../safety/crisisEnforcer.ts';
import { imminentStayNote, parseRiskArgs, RiskLatch, type RiskKind } from '../safety/riskRating.ts';
import type { ControlPlaneAction } from '../types.ts';

export const SAFETY_HEARTBEAT_FALLBACK_MS = 12_000;

/** What the controller must do after a safety verdict. */
export interface SafetyOutcome {
  /** An application note for the model. */
  note: string;
  /** Send immediately (imminent), rather than when MindPal is next idle. */
  urgent: boolean;
}

/** The parts of the control plane client this needs. */
export interface SafetyControl {
  syncTranscripts(
    input: string,
    output: string,
    options?: { isFinal?: boolean },
  ): Promise<ControlPlaneAction>;
  reportRisk(risk: number, kind: string, band: string, confirmations: number): Promise<ControlPlaneAction>;
  readonly sessionMissing: boolean;
}

export interface SafetyTrace {
  add(category: 'risk' | 'control', event: string, data?: Record<string, unknown>): void;
}

function dangerKindOf(value: string | undefined): RiskKind {
  return value === 'physical' || value === 'self_harm' ? value : 'unspecified';
}

export class SafetyBridge {
  private supportingNow = false;
  private imminentSent = false;
  private unverifiedRuns = 0;
  private lastSyncAt: number;
  private readonly heartbeatMs: number;
  private readonly latch = new RiskLatch();
  private readonly control: SafetyControl;
  private readonly trace: SafetyTrace;

  constructor(control: SafetyControl, trace: SafetyTrace, now: number, heartbeatMs?: number) {
    this.control = control;
    this.trace = trace;
    this.lastSyncAt = now;
    this.heartbeatMs = Math.max(2_000, heartbeatMs || SAFETY_HEARTBEAT_FALLBACK_MS);
  }

  get supporting(): boolean {
    return this.supportingNow;
  }

  get peakRisk(): number {
    return this.latch.peakRisk;
  }

  get sessionMissing(): boolean {
    return this.control.sessionMissing;
  }

  heartbeatDue(now: number): boolean {
    return now - this.lastSyncAt >= this.heartbeatMs;
  }

  /** Classify the call so far. `isFinal` at the end of a caller turn. */
  async sync(user: string, model: string, isFinal: boolean, now: number): Promise<SafetyOutcome | null> {
    this.lastSyncAt = now;
    let result: ControlPlaneAction;
    try {
      result = await this.control.syncTranscripts(user, model, { isFinal });
    } catch {
      return null;
    }
    return this.verdict(result);
  }

  /** Apply a server verdict. Exposed for tests; `sync` calls it. */
  verdict(result: ControlPlaneAction): SafetyOutcome | null {
    if (result.action === 'safety_unverified') {
      // Deliberately non-terminal: a classifier blip must not end a live call.
      // Visible, because an unverified stretch is a window nothing is checking.
      this.unverifiedRuns += 1;
      if (this.unverifiedRuns === 1 || this.unverifiedRuns % 5 === 0) {
        console.info('[mindpal.voice] safety_unverified', { consecutive: this.unverifiedRuns });
      }
      return null;
    }
    this.unverifiedRuns = 0;
    // Older servers still send speak-then-pause or escalate. There is no pause
    // any more: all of them mean "stay, and name immediate help".
    if (shouldSpeakFirst(result) || isEscalateAction(result.action) || (result.action === 'stay_support' && result.imminent)) {
      return this.imminent(dangerKindOf(result.danger_kind));
    }
    if (result.action === 'stay_support') return this.support(result.session_note);
    return null;
  }

  /** The Live model's `report_risk` tool call. Returns null if the args are not a report. */
  riskTool(args: Record<string, unknown>, now: number): { handled: boolean; outcome: SafetyOutcome | null } {
    const report = parseRiskArgs(args);
    if (!report) return { handled: false, outcome: null };
    const decision = this.latch.note(report, now);
    this.trace.add('risk', 'report', {
      risk: report.risk,
      kind: report.kind,
      band: decision.band,
      confirmations: decision.confirmations,
      pause: decision.pause,
    });
    void this.control.reportRisk(report.risk, report.kind, decision.band, decision.confirmations).catch(() => {});
    if (decision.band === 'ordinary') return { handled: true, outcome: null };
    // An unconfirmed imminent rating still slows the call down right away.
    const outcome = decision.pause ? this.imminent(report.kind) : this.support();
    return { handled: true, outcome };
  }

  private support(sessionNote?: string): SafetyOutcome | null {
    if (this.supportingNow) return null;
    this.supportingNow = true;
    this.trace.add('risk', 'stay_support', {});
    return { note: sessionNote || STAY_SUPPORT_NOTE, urgent: false };
  }

  private imminent(kind: RiskKind): SafetyOutcome | null {
    this.supportingNow = true;
    // Once per call, even if a milder support note already went out.
    if (this.imminentSent) return null;
    this.imminentSent = true;
    this.trace.add('risk', 'imminent_stay', { kind });
    return { note: imminentStayNote(kind), urgent: true };
  }
}
