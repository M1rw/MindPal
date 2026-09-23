import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseTrace,
  MAX_EVENTS,
  UNANSWERED_MS,
  VoiceTrace,
} from '../../frontend/src/voice/diagnostics/trace.ts';

/** Build a timeline by hand so the analyser is tested, not the recorder. */
function timeline(rows) {
  return rows.map(([t, category, event, data]) => ({ t, category, event, data }));
}

describe('voice flight recorder', () => {
  it('coalesces the realtime firehose instead of recording every chunk', () => {
    const trace = new VoiceTrace('s1');
    // A 30-minute call is ~90k PCM chunks and ~90k mic frames. Recording each
    // one would cost more than the bug it is meant to catch.
    for (let i = 0; i < 2000; i += 1) trace.noteModelAudio(480);
    for (let i = 0; i < 2000; i += 1) trace.noteMicFrame(false);
    assert.ok(trace.size < 60, `expected a handful of rows, got ${trace.size}`);
    assert.ok(trace.size > 0, 'but it must record something');
  });

  it('never throws into the audio path', () => {
    const trace = new VoiceTrace('s1');
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => trace.add('audio', 'weird', circular));
    assert.doesNotThrow(() => trace.noteModelAudio(Number.NaN));
  });

  it('is bounded, so a long call cannot exhaust memory', () => {
    const trace = new VoiceTrace('s1');
    for (let i = 0; i < MAX_EVENTS + 500; i += 1) trace.add('floor', 'transition');
    assert.equal(trace.size, MAX_EVENTS);
    assert.ok(trace.report().droppedEvents > 0, 'dropping must be reported, not hidden');
  });
});

describe('the analyser finds the failures we keep chasing', () => {
  it('flags a user turn that got no reply', () => {
    const findings = analyseTrace(
      timeline([
        [1000, 'vad', 'user_final', { text: 'so what do you think' }],
        [1200, 'floor', 'transition', { to: 'listening' }],
      ]),
    );
    assert.equal(findings.unanswered.length, 1);
    assert.match(findings.unanswered[0].detail, /no model audio/);
    assert.match(findings.notes.join(' '), /got no reply/);
  });

  it('does not flag a turn that was answered promptly', () => {
    const findings = analyseTrace(
      timeline([
        [1000, 'vad', 'user_final', { text: 'hello' }],
        [1600, 'audio', 'model_audio_run', { startedT: 1600, endedT: 5000, durationMs: 3400 }],
      ]),
    );
    assert.equal(findings.unanswered.length, 0);
    assert.equal(findings.summary.modelTurns, 1);
  });

  it('flags a reply that started and stalled, with the interrupt that caused it', () => {
    // "it stays first word then stop talking"
    const findings = analyseTrace(
      timeline([
        [1000, 'vad', 'user_final', { text: 'tell me a story' }],
        [1400, 'interrupt', 'decision', { flush: true, reason: 'contentful_or_energy' }],
        [1300, 'audio', 'model_audio_run', { startedT: 1300, endedT: 1550, durationMs: 250 }],
      ]),
    );
    assert.equal(findings.stalls.length, 1);
    assert.equal(findings.stalls[0].data.interruptReason, 'contentful_or_energy');
    assert.equal(findings.stalls[0].data.interruptFlushed, true);
  });

  it('does not call a short reply a stall when the turn ended cleanly', () => {
    const findings = analyseTrace(
      timeline([
        [1000, 'audio', 'model_audio_run', { startedT: 1000, endedT: 1300, durationMs: 300 }],
        [1350, 'audio', 'generation_complete', {}],
      ]),
    );
    assert.equal(findings.stalls.length, 0, '"mm-hmm" is a legitimate short turn');
  });

  it('flags caption damage the caller could see on screen', () => {
    const findings = analyseTrace(
      timeline([
        [900, 'caption', 'model', { text: 'I understand <ctrl46> that' }],
        [950, 'caption', 'user', { text: 'ذاوضعمعقديبدووكأنكتشعربالحيرةبينمانشاعرك' }],
        [990, 'caption', 'user', { text: 'going going going to talk' }],
      ]),
    );
    const kinds = findings.captionAnomalies.map((f) => f.kind);
    assert.ok(kinds.includes('control_token_visible'));
    assert.ok(kinds.includes('arabic_words_glued'));
    assert.ok(kinds.includes('caption_repetition'));
  });

  it('flags a control plane that refused events, because safety did not run', () => {
    const findings = analyseTrace(
      timeline([
        [500, 'control', 'response', { request: 'voice.transcript.sync', status: 401 }],
        [700, 'control', 'response', { request: 'voice.floor.transition', status: 404 }],
        [900, 'control', 'response', { request: 'voice.transcript.sync', status: 200, action: 'continue' }],
      ]),
    );
    assert.equal(findings.controlFailures.length, 2);
    assert.match(findings.notes.join(' '), /safety classification did not run/);
  });

  it('produces a clean report for a healthy call', () => {
    const findings = analyseTrace(
      timeline([
        [500, 'vad', 'user_final', { text: 'hi' }],
        [900, 'audio', 'model_audio_run', { startedT: 900, endedT: 4000, durationMs: 3100 }],
        [4100, 'audio', 'generation_complete', {}],
        [4200, 'control', 'response', { request: 'voice.transcript.sync', status: 200, action: 'continue' }],
      ]),
    );
    assert.equal(findings.notes.length, 0, 'a healthy call should say nothing alarming');
    assert.equal(findings.unanswered.length, 0);
    assert.equal(findings.stalls.length, 0);
  });

  it('reports a session where the model never spoke at all', () => {
    const findings = analyseTrace(timeline([[100, 'session', 'start_clicked']]));
    assert.match(findings.notes.join(' '), /No model audio/);
  });

  it('exposes a summary a human can read at a glance', () => {
    const report = new VoiceTrace('s1').report({ reason: 'test' });
    assert.equal(report.schema, 'mindpal.voice.trace/1');
    assert.ok(report.context.reason === 'test');
    assert.equal(typeof report.findings.summary.interrupts, 'number');
    assert.ok(UNANSWERED_MS > 0);
  });
});

describe('a completion from a previous turn cannot excuse this one', () => {
  it('still flags a stall when the only completion came earlier', () => {
    // Found by replaying a real-shaped session: matching on absolute distance
    // let turn 1's generation_complete mark turn 2 as clean.
    const findings = analyseTrace(
      timeline([
        [1000, 'audio', 'model_audio_run', { startedT: 1000, endedT: 4000, durationMs: 3000 }],
        [4050, 'audio', 'generation_complete', {}],
        [5000, 'vad', 'user_final', { text: 'tell me a long story' }],
        [5200, 'audio', 'model_audio_run', { startedT: 5200, endedT: 5350, durationMs: 150 }],
        [5300, 'interrupt', 'decision', { flush: true, reason: 'contentful_or_energy' }],
      ]),
    );
    assert.equal(findings.stalls.length, 1, 'turn 2 stalled and must be reported');
    assert.equal(findings.stalls[0].data.interruptReason, 'contentful_or_energy');
  });

  it('still accepts a completion that genuinely follows the run', () => {
    const findings = analyseTrace(
      timeline([
        [1000, 'audio', 'model_audio_run', { startedT: 1000, endedT: 1200, durationMs: 200 }],
        [1400, 'audio', 'generation_complete', {}],
      ]),
    );
    assert.equal(findings.stalls.length, 0);
  });
});

describe('a missing user endpoint must not be silent', () => {
  it('says so when the model spoke but no user turn was ever detected', () => {
    // The real trace that surfaced this: modelTurns 3, userTurns 0. Everything
    // gated on a final - including the crisis classifier - had not run.
    const findings = analyseTrace(
      timeline([
        [500, 'audio', 'model_audio_run', { startedT: 500, endedT: 4000, durationMs: 3500 }],
        [4100, 'caption', 'user', { text: 'I was saying something' }],
        [9000, 'audio', 'model_audio_run', { startedT: 9000, endedT: 12000, durationMs: 3000 }],
      ]),
    );
    assert.match(findings.notes.join(' '), /NO user turn endpoint/);
    assert.match(findings.notes.join(' '), /Safety classification/);
    assert.equal(findings.summary.userTurns, 0);
    assert.equal(findings.summary.modelTurns, 2);
  });

  it('reports how many endpoints had to be derived locally', () => {
    const findings = analyseTrace(
      timeline([
        [500, 'vad', 'user_final', { text: 'one', derived: false }],
        [1500, 'vad', 'user_final', { text: 'two', derived: true, source: 'idle' }],
        [2500, 'vad', 'user_final', { text: 'three', derived: true, source: 'model_started' }],
        [600, 'audio', 'model_audio_run', { startedT: 600, endedT: 3000, durationMs: 2400 }],
      ]),
    );
    assert.equal(findings.summary.userTurns, 3);
    assert.equal(findings.summary.userTurnsDerivedLocally, 2);
  });

  it('counts safety classifies, so a dormant classifier is visible', () => {
    const findings = analyseTrace(
      timeline([
        [500, 'control', 'response', { request: 'voice.transcript.sync', status: 200, action: 'continue' }],
        [900, 'control', 'response', { request: 'voice.floor.transition', status: 200 }],
      ]),
    );
    assert.equal(findings.summary.safetyClassifies, 1);
  });
});

describe('findings from the 2026-09-17 trace', () => {
  it('reports when playback fell back off the worklet', () => {
    // The trace showed streaming:false - every worklet test passed, but the
    // node never loaded in the real app and nothing said so.
    const findings = analyseTrace(
      timeline([
        [300, 'playback', 'worklet_failed', { addModuleError: 'AbortError: failed to load' }],
        [500, 'playback', 'fallback_path_active', { reason: 'no worklet node' }],
        [900, 'audio', 'model_audio_run', { startedT: 900, endedT: 4000, durationMs: 3100 }],
      ]),
    );
    assert.match(findings.notes.join(' '), /AudioWorklet failed to load/);
    assert.match(findings.notes.join(' '), /AbortError/);
    assert.equal(findings.summary.playbackWorkletReady, 0);
  });

  it('still reports the fallback when only the node construction failed', () => {
    const findings = analyseTrace(
      timeline([[300, 'playback', 'fallback_path_active', { reason: 'no worklet node' }]]),
    );
    assert.match(findings.notes.join(' '), /per-chunk fallback/);
  });

  it('says nothing about playback when the worklet loaded cleanly', () => {
    const findings = analyseTrace(
      timeline([
        [300, 'playback', 'worklet_ready', { sampleRate: 48000 }],
        [900, 'audio', 'model_audio_run', { startedT: 900, endedT: 4000, durationMs: 3100 }],
      ]),
    );
    assert.equal(findings.summary.playbackWorkletReady, 1);
    assert.doesNotMatch(findings.notes.join(' '), /fallback/);
  });
});

describe('the 91-second stall must be caught automatically', () => {
  it('flags transcription silence while the microphone was live', () => {
    const rows = [[1000, 'caption', 'user', { text: 'first' }]];
    // Mic summaries every 5s proving capture never stopped.
    for (let t = 5000; t < 90000; t += 5000) {
      rows.push([t, 'mic', 'frames', { frames: 250, gatedPct: 0, uplink: { sent: 250, dropped: 0 } }]);
    }
    rows.push([92000, 'caption', 'user', { text: 'first then much later' }]);

    const findings = analyseTrace(timeline(rows));
    const stall = findings.captionAnomalies.find((f) => f.kind === 'asr_stalled');
    assert.ok(stall, 'a 91s transcription gap must be reported');
    assert.match(findings.notes.join(' '), /No transcription for \d+s/);
    assert.equal(stall.data.gatedPct, 0, 'and it must say the mic was not gated');
    assert.deepEqual(stall.data.uplinkAtEnd, { sent: 250, dropped: 0 });
  });

  it('does not call a quiet room a stall', () => {
    const rows = [[1000, 'caption', 'user', { text: 'first' }]];
    // No mic summaries: capture was not running, so silence is expected.
    rows.push([92000, 'caption', 'user', { text: 'later' }]);
    const findings = analyseTrace(timeline(rows));
    assert.equal(findings.captionAnomalies.filter((f) => f.kind === 'asr_stalled').length, 0);
  });

  it('counts interrupts that were correctly ignored', () => {
    const findings = analyseTrace(
      timeline([
        [1000, 'interrupt', 'decision', { flush: true, reason: 'contentful_or_energy' }],
        [1001, 'interrupt', 'ignored_nothing_playing', { reason: 'contentful_or_energy' }],
      ]),
    );
    assert.equal(findings.summary.interrupts, 1, 'decisions only, not every interrupt event');
    assert.equal(findings.summary.interruptsIgnoredNothingPlaying, 1);
  });
});

describe('a pause mid-thought is not an unanswered turn', () => {
  it('only flags the fragment the caller actually stopped on', async () => {
    const { analyseTrace } = await import('../../frontend/src/voice/diagnostics/trace.ts');
    // Three fragments of one thought, then one reply after the last.
    const events = [
      { t: 1000, category: 'vad', event: 'user_final', data: { text: 'I want to tell you' } },
      { t: 3000, category: 'vad', event: 'user_final', data: { text: 'something strong' } },
      { t: 5000, category: 'vad', event: 'user_final', data: { text: 'with you.' } },
      { t: 6500, category: 'audio', event: 'model_audio_run', data: { startedT: 6000, endedT: 6400, durationMs: 400 } },
    ];
    const findings = analyseTrace(events);
    assert.equal(findings.unanswered.length, 0, 'the caller was still talking; nothing went unanswered');
  });
});

describe('a reply that arrives faster than it plays is not a stall', () => {
  it('judges by audio length, not arrival time (trace 18-28)', () => {
    // 4.7s of speech streamed in 0.9s, completion 1.3s after the last chunk.
    const findings = analyseTrace(
      timeline([
        [21439, 'audio', 'model_audio_run', { startedT: 21439, endedT: 22347, durationMs: 908, approxAudioMs: 4720 }],
        [23641, 'audio', 'generation_complete', { chars: 70 }],
      ]),
    );
    assert.equal(findings.stalls.length, 0);
  });

  it('still flags a genuinely short, unfinished reply', () => {
    const findings = analyseTrace(
      timeline([[1000, 'audio', 'model_audio_run', { startedT: 1000, endedT: 1100, durationMs: 100, approxAudioMs: 300 }]]),
    );
    assert.equal(findings.stalls.length, 1);
  });
});
