/**
 * Voice session flight recorder.
 *
 * Live-voice bugs are hard to catch because they are timing bugs: the floor, the
 * provider socket, the microphone gate, playback occupancy and the control plane
 * all move at once, and by the time a symptom is visible ("it stopped
 * responding") the state that caused it is gone. Console logs show fragments in
 * the wrong order and drop under load.
 *
 * So every meaningful transition is recorded here with a monotonic timestamp,
 * kept in a bounded ring, and dumped as one JSON file at hangup - together with
 * an analysis pass that looks for the specific failures we keep chasing: a user
 * turn that got no reply, a reply that started and stalled, a caption that
 * doubled or lost its spacing.
 *
 * Constraints this has to respect:
 *  - It runs alongside a realtime audio path. High-rate signals (mic frames,
 *    PCM chunks) are COALESCED, never recorded per event.
 *  - It must never throw into the audio path.
 *  - The dump contains transcripts, because seeing what the caller actually saw
 *    is the entire point. It stays on the device unless someone sends it.
 */

export type TraceCategory =
  | 'session'
  | 'mint'
  | 'socket'
  | 'setup'
  | 'floor'
  | 'audio'
  | 'playback'
  | 'caption'
  | 'interrupt'
  | 'vad'
  | 'control'
  | 'tool'
  | 'risk'
  | 'mic'
  | 'error';

export interface TraceEvent {
  /** Milliseconds since the recorder started. Monotonic, not wall clock. */
  t: number;
  category: TraceCategory;
  event: string;
  data?: Record<string, unknown>;
}

/** 30 minutes of coalesced events fits comfortably; the cap is a safety net. */
export const MAX_EVENTS = 20_000;

/** A user turn with no model audio within this window counts as unanswered. */
export const UNANSWERED_MS = 6_000;

/** Model audio that starts and stops sooner than this looks like a stall. */
export const STALL_MS = 1_200;

/** Silence longer than this, with the mic live, is a stall rather than a pause. */
export const ASR_STALL_MS = 20_000;

interface CoalescedAudio {
  firstT: number;
  lastT: number;
  chunks: number;
  samples: number;
}

export class VoiceTrace {
  private events: TraceEvent[] = [];
  private startedAt = 0;
  private dropped = 0;
  private audioRun: CoalescedAudio | null = null;
  private micFrames = 0;
  private micGatedFrames = 0;
  private lastMicFlushT = 0;
  readonly sessionId: string;

  constructor(sessionId = '') {
    this.sessionId = sessionId;
    this.startedAt = now();
  }

  private stamp(): number {
    return Math.round(now() - this.startedAt);
  }

  /** Never throws. A broken recorder must not take the call down with it. */
  add(category: TraceCategory, event: string, data?: Record<string, unknown>): void {
    try {
      if (this.events.length >= MAX_EVENTS) {
        this.dropped += 1;
        return;
      }
      this.events.push({ t: this.stamp(), category, event, ...(data ? { data } : {}) });
    } catch {
      /* diagnostics must never break the call */
    }
  }

  /**
   * Model PCM arrives ~50x/second. Recording each chunk would be 90k events in a
   * 30-minute call, so a continuous run collapses into one entry: when audio
   * started, when it stopped, and how much there was.
   */
  noteModelAudio(samples: number, gapMs = 400): void {
    const t = this.stamp();
    const run = this.audioRun;
    if (run && t - run.lastT <= gapMs) {
      run.lastT = t;
      run.chunks += 1;
      run.samples += samples;
      return;
    }
    this.flushAudioRun();
    this.audioRun = { firstT: t, lastT: t, chunks: 1, samples };
    this.add('audio', 'model_audio_start');
  }

  flushAudioRun(): void {
    const run = this.audioRun;
    if (!run) return;
    this.audioRun = null;
    this.add('audio', 'model_audio_run', {
      startedT: run.firstT,
      endedT: run.lastT,
      durationMs: run.lastT - run.firstT,
      chunks: run.chunks,
      approxAudioMs: Math.round((run.samples / 24000) * 1000),
    });
  }

  /** Mic frames are 50/s. Only a periodic summary is kept. */
  noteMicFrame(
    gated: boolean,
    uplink?: () => Record<string, number> | undefined,
    flushEveryMs = 5_000,
  ): void {
    this.micFrames += 1;
    if (gated) this.micGatedFrames += 1;
    const t = this.stamp();
    if (t - this.lastMicFlushT < flushEveryMs) return;
    this.lastMicFlushT = t;
    // Uplink counters sit beside the capture counters on purpose: "the mic was
    // live" and "audio reached the provider" are different claims, and a trace
    // that only proves the first cannot explain 90 seconds of silence.
    const up = uplink?.();
    this.add('mic', 'frames', {
      frames: this.micFrames,
      gatedFrames: this.micGatedFrames,
      gatedPct: this.micFrames ? Math.round((this.micGatedFrames / this.micFrames) * 100) : 0,
      ...(up ? { uplink: up } : {}),
    });
    this.micFrames = 0;
    this.micGatedFrames = 0;
  }

  get size(): number {
    return this.events.length;
  }

  all(): TraceEvent[] {
    return this.events;
  }

  /** The full report: raw timeline plus the derived findings. */
  report(extra?: Record<string, unknown>): VoiceTraceReport {
    this.flushAudioRun();
    return {
      schema: 'mindpal.voice.trace/1',
      sessionId: this.sessionId,
      capturedAt: new Date().toISOString(),
      durationMs: this.stamp(),
      eventCount: this.events.length,
      droppedEvents: this.dropped,
      ...(extra ? { context: extra } : {}),
      findings: analyseTrace(this.events),
      events: this.events,
    };
  }
}

export interface TraceFinding {
  kind: string;
  t: number;
  detail: string;
  data?: Record<string, unknown>;
}

export interface VoiceTraceReport {
  schema: string;
  sessionId: string;
  capturedAt: string;
  durationMs: number;
  eventCount: number;
  droppedEvents: number;
  context?: Record<string, unknown>;
  findings: TraceFindings;
  events: TraceEvent[];
}

export interface TraceFindings {
  summary: Record<string, number>;
  unanswered: TraceFinding[];
  stalls: TraceFinding[];
  captionAnomalies: TraceFinding[];
  controlFailures: TraceFinding[];
  notes: string[];
}

function now(): number {
  try {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Turn the timeline into the answers we actually want, rather than leaving a
 * human to scroll 20k rows looking for them.
 */
export function analyseTrace(events: TraceEvent[]): TraceFindings {
  const unanswered: TraceFinding[] = [];
  const stalls: TraceFinding[] = [];
  const captionAnomalies: TraceFinding[] = [];
  const controlFailures: TraceFinding[] = [];
  const notes: string[] = [];

  const audioRuns = events.filter((e) => e.event === 'model_audio_run');
  const userFinals = events.filter((e) => e.event === 'user_final');

  // A user turn that got no model audio after it.
  //
  // Skipped when the caller simply kept talking: the local endpointer closes a
  // turn at every ~1s pause, and flagging each mid-thought fragment as
  // "unanswered" buried the real failures under ones that were just breath.
  for (const [index, final] of userFinals.entries()) {
    const next = userFinals[index + 1];
    const repliedBeforeNext = audioRuns.some(
      (run) => run.t >= final.t - 200 && (!next || Number(run.data?.startedT ?? run.t) < next.t),
    );
    if (next && !repliedBeforeNext && next.t - final.t < UNANSWERED_MS) continue;
    const reply = audioRuns.find((run) => run.t >= final.t - 200);
    const replyT = reply ? Number(reply.data?.startedT ?? reply.t) : Infinity;
    if (!reply || replyT - final.t > UNANSWERED_MS) {
      unanswered.push({
        kind: 'user_turn_unanswered',
        t: final.t,
        detail: reply
          ? `reply began ${Math.round(replyT - final.t)}ms after the user finished`
          : 'no model audio followed this user turn',
        data: { transcript: final.data?.text, waitedMs: reply ? replyT - final.t : null },
      });
    }
  }

  // A reply that began and died almost immediately: the "first word then stops"
  // shape. Only counts when nothing signalled a normal end of turn.
  for (const run of audioRuns) {
    // Audio LENGTH, not arrival span. Gemini streams faster than real time: a
    // 4.7s reply arrives in 0.9s, and measuring arrival flagged healthy replies
    // as "began and stopped".
    const duration = Number(run.data?.approxAudioMs ?? run.data?.durationMs ?? 0);
    if (duration >= STALL_MS) continue;
    const endedT = Number(run.data?.endedT ?? run.t);
    // The completion must come AFTER this run ended. Matching on absolute
    // distance let the PREVIOUS turn's generation_complete excuse this turn's
    // stall, which is exactly the failure this is supposed to catch.
    const clean = events.some(
      (e) =>
        (e.event === 'generation_complete' || e.event === 'turn_complete') &&
        e.t >= endedT - 50 &&
        e.t - endedT < 2_000,
    );
    if (clean) continue;
    const culprit = events
      .filter((e) => e.category === 'interrupt' && e.t >= run.t - 200 && e.t <= endedT + 400)
      .slice(-1)[0];
    stalls.push({
      kind: 'reply_stalled',
      t: run.t,
      detail: `model audio lasted ${duration}ms with no completion signal`,
      data: {
        approxAudioMs: run.data?.approxAudioMs,
        interruptReason: culprit?.data?.reason ?? null,
        interruptFlushed: culprit?.data?.flush ?? null,
      },
    });
  }

  // Captions: the things that were visibly wrong on screen.
  for (const caption of events.filter((e) => e.category === 'caption')) {
    const text = String(caption.data?.text ?? '');
    if (!text) continue;
    if (/<\s*ctrl\s*\d+\s*>|<\|/.test(text)) {
      captionAnomalies.push({
        kind: 'control_token_visible',
        t: caption.t,
        detail: 'provider control token reached the caption',
        data: { text: text.slice(0, 120) },
      });
    }
    const glued = text.match(/[؀-ۿ]{18,}/);
    if (glued) {
      captionAnomalies.push({
        kind: 'arabic_words_glued',
        t: caption.t,
        detail: 'long unbroken Arabic run suggests lost word spacing',
        data: { sample: glued[0].slice(0, 40) },
      });
    }
    const doubled = text.match(/\b(\w{3,})\s+\1\s+\1\b/i);
    if (doubled) {
      captionAnomalies.push({
        kind: 'caption_repetition',
        t: caption.t,
        detail: 'same word repeated three times: likely a merge bug',
        data: { sample: doubled[0] },
      });
    }
  }

  for (const call of events.filter((e) => e.category === 'control' && e.event === 'response')) {
    const status = Number(call.data?.status ?? 0);
    const action = String(call.data?.action ?? '');
    if (status >= 400 || action === 'safety_unverified') {
      controlFailures.push({
        kind: status >= 400 ? `http_${status}` : 'safety_unverified',
        t: call.t,
        detail: `${call.data?.request ?? 'event'} -> ${status || action}`,
        data: call.data,
      });
    }
  }

  // A long stretch where the microphone was live and ungated but the provider
  // returned no transcription at all. A real trace had 91 seconds of this while
  // two people talked; the mic summaries proved capture was fine, so the silence
  // was upstream - either audio not reaching the provider, or the provider's VAD
  // never closing a turn.
  const micSummaries = events.filter((e) => e.category === 'mic' && e.event === 'frames');
  const userCaptions = events.filter((e) => e.category === 'caption' && e.event === 'user');
  for (let i = 1; i < userCaptions.length; i += 1) {
    const gapMs = userCaptions[i].t - userCaptions[i - 1].t;
    if (gapMs < ASR_STALL_MS) continue;
    const window = micSummaries.filter(
      (m) => m.t > userCaptions[i - 1].t && m.t < userCaptions[i].t,
    );
    const live = window.filter((m) => Number(m.data?.frames ?? 0) > 50);
    if (live.length < 2) continue; // the mic really was idle; not a stall
    const uplink = live[live.length - 1]?.data?.uplink as Record<string, number> | undefined;
    notes.push(
      `No transcription for ${Math.round(gapMs / 1000)}s while the microphone was live.`,
    );
    captionAnomalies.push({
      kind: 'asr_stalled',
      t: userCaptions[i - 1].t,
      detail: `${Math.round(gapMs / 1000)}s with capture running and nothing transcribed`,
      data: {
        gapMs,
        micSummaries: live.length,
        gatedPct: Math.max(...live.map((m) => Number(m.data?.gatedPct ?? 0))),
        uplinkAtEnd: uplink ?? null,
      },
    });
  }

  const workletFailed = events.find((e) => e.event === 'worklet_failed');
  if (workletFailed) {
    notes.push(
      'Playback AudioWorklet failed to load; the per-chunk fallback ran instead. ' +
        `Reason: ${workletFailed.data?.addModuleError || workletFailed.data?.nodeError}`,
    );
  } else if (events.some((e) => e.event === 'fallback_path_active')) {
    notes.push('Playback used the per-chunk fallback path, which drops audio under load.');
  }

  if (!audioRuns.length) notes.push('No model audio was recorded for this session at all.');
  if (unanswered.length) {
    notes.push(
      `${unanswered.length} user turn(s) got no reply within ${UNANSWERED_MS / 1000}s.`,
    );
  }
  if (stalls.length) {
    notes.push(`${stalls.length} reply/replies began and stopped without a completion signal.`);
  }
  if (controlFailures.length) {
    notes.push(
      `${controlFailures.length} control-plane call(s) failed or returned unverified; safety classification did not run for those.`,
    );
  }

  // A session with model turns but zero user turns means the endpoint signal is
  // missing - and everything gated on a user final (crucially the crisis
  // classifier) silently did not run. That is worth saying out loud.
  if (audioRuns.length > 0 && userFinals.length === 0) {
    notes.push(
      'Model spoke but NO user turn endpoint was ever detected. Safety classification ' +
        'does not run without one.',
    );
  }

  const derivedFinals = userFinals.filter((e) => e.data?.derived === true).length;

  const summary: Record<string, number> = {
    modelTurns: audioRuns.length,
    userTurns: userFinals.length,
    userTurnsDerivedLocally: derivedFinals,
    captionUpdates: events.filter((e) => e.category === 'caption').length,
    safetyClassifies: events.filter(
      (e) => e.category === 'control' && e.data?.request === 'voice.transcript.sync',
    ).length,
    unanswered: unanswered.length,
    stalls: stalls.length,
    captionAnomalies: captionAnomalies.length,
    controlFailures: controlFailures.length,
    multiPartyStretches: events.filter(
      (e) => e.event === 'multi_party' && e.data?.multiParty === true,
    ).length,
    interruptsIgnoredNothingPlaying: events.filter(
      (e) => e.event === 'ignored_nothing_playing',
    ).length,
    interrupts: events.filter((e) => e.category === 'interrupt' && e.event === 'decision').length,
    flushedInterrupts: events.filter((e) => e.category === 'interrupt' && e.data?.flush === true)
      .length,
    floorTransitions: events.filter((e) => e.category === 'floor').length,
    playbackWorkletReady: events.filter((e) => e.event === 'worklet_ready').length,
    playbackUnderruns: events.filter((e) => e.event === 'underrun').length,
    playbackOverflows: events.filter((e) => e.event === 'overflow').length,
    errors: events.filter((e) => e.category === 'error').length,
  };

  return { summary, unanswered, stalls, captionAnomalies, controlFailures, notes };
}

/** Trigger a download of the report. Returns false when the DOM refuses. */
export function downloadTrace(report: VoiceTraceReport, filename?: string): boolean {
  try {
    const name =
      filename ||
      `mindpal-voice-trace-${report.capturedAt.replace(/[:.]/g, '-')}.json`;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}
