import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { transition } from '../../frontend/src/voice/call/callMachine.ts';
import {
  EMPTY_GENERATION_GRACE_MS,
  ReplyGuard,
  SILENT_GENERATION_MS,
} from '../../frontend/src/voice/call/replyGuard.ts';
import { CallTranscript, SAFETY_WINDOW_CHARS } from '../../frontend/src/voice/call/transcript.ts';
import { SafetyBridge } from '../../frontend/src/voice/call/safetyBridge.ts';
import { rollingContinuation, rotateDelayMs, renewDelayMs, usableSuccessor } from '../../frontend/src/voice/call/lifecycle.ts';

const PHASES = ['idle', 'connecting', 'listening', 'userSpeaking', 'waitingReply', 'speaking', 'reconnecting', 'ended'];
const EVENTS = [
  { type: 'connect' },
  { type: 'ready' },
  { type: 'userWords' },
  { type: 'userPaused', spoke: true },
  { type: 'userPaused', spoke: false },
  { type: 'modelAudio' },
  { type: 'interrupted' },
  { type: 'playbackIdle' },
  { type: 'dropped' },
  { type: 'end' },
];

/** Every legal move, written out. Anything not listed must leave the phase alone. */
const EXPECTED = {
  'idle+connect': ['connecting', []],
  'connecting+ready': ['listening', []],
  'reconnecting+ready': ['listening', []],
  'listening+userWords': ['userSpeaking', []],
  'waitingReply+userWords': ['userSpeaking', ['thinkingOff']],
  'userSpeaking+userPaused:true': ['waitingReply', ['commitUser', 'thinkingOn']],
  'userSpeaking+userPaused:false': ['listening', []],
  'listening+modelAudio': ['speaking', []],
  'userSpeaking+modelAudio': ['speaking', ['commitUser']],
  'waitingReply+modelAudio': ['speaking', ['thinkingOff']],
  'speaking+interrupted': ['userSpeaking', ['flushPlayback']],
  'speaking+playbackIdle': ['listening', []],
  'listening+dropped': ['reconnecting', []],
  'userSpeaking+dropped': ['reconnecting', []],
  'waitingReply+dropped': ['reconnecting', ['thinkingOff']],
  'speaking+dropped': ['reconnecting', []],
};

function key(phase, event) {
  const suffix = event.type === 'userPaused' ? `:${event.spoke}` : '';
  return `${phase}+${event.type}${suffix}`;
}

describe('call state machine', () => {
  for (const phase of PHASES) {
    for (const event of EVENTS) {
      const name = key(phase, event);
      it(name, () => {
        const result = transition(phase, event);
        if (event.type === 'end') {
          assert.equal(result.phase, 'ended');
          assert.deepEqual(result.effects, phase === 'waitingReply' ? ['thinkingOff'] : []);
          return;
        }
        const [expectedPhase, expectedEffects] = EXPECTED[name] ?? [phase, []];
        assert.equal(result.phase, expectedPhase);
        assert.deepEqual(result.effects, expectedEffects);
      });
    }
  }
});

describe('reply guard', () => {
  it('owes nothing until a turn ends', () => {
    const guard = new ReplyGuard();
    guard.generationComplete(0);
    assert.equal(guard.poll(10_000), false);
  });

  it('nudges an empty generation after the grace, once', () => {
    const guard = new ReplyGuard();
    guard.userTurnEnded(0);
    guard.generationComplete(100);
    assert.equal(guard.poll(100 + EMPTY_GENERATION_GRACE_MS - 1), false);
    assert.equal(guard.poll(100 + EMPTY_GENERATION_GRACE_MS), 'empty_generation');
    assert.equal(guard.poll(100_000), false);
  });

  it('nudges a control-token-only generation, timed from the later of turn end and generation start', () => {
    const guard = new ReplyGuard();
    guard.generationDelta(0, false);
    guard.userTurnEnded(600);
    assert.equal(guard.poll(600 + SILENT_GENERATION_MS - 1), false);
    assert.equal(guard.poll(600 + SILENT_GENERATION_MS), 'silent_generation');
  });

  it('never nudges once real words or audio began', () => {
    const guard = new ReplyGuard();
    guard.userTurnEnded(0);
    guard.generationDelta(100, true);
    guard.generationComplete(200);
    assert.equal(guard.poll(60_000), false);
  });

  it('never nudges a turn that is only slow', () => {
    const guard = new ReplyGuard();
    guard.userTurnEnded(0);
    assert.equal(guard.poll(30_000), false, 'no generation at all is Gemini still thinking, not silence');
  });
});

describe('call transcript', () => {
  it('drops ASR markers and keeps words', () => {
    const t = new CallTranscript();
    assert.equal(t.userDelta('<noise>'), null);
    assert.equal(t.userDelta(' Hello'), 'Hello');
    assert.equal(t.userDelta(' there'), 'Hello there');
    assert.equal(t.takeUserTurn(), 'Hello there');
    assert.equal(t.takeUserTurn(), '', 'handed back once');
  });

  it('only keeps MindPal text that was actually heard', () => {
    const t = new CallTranscript();
    t.modelDelta("I'm doing");
    assert.equal(t.takeModelTurn(), '', 'abandoned text is not a turn');
    t.modelDelta('Hi!');
    t.noteModelAudio();
    assert.equal(t.takeModelTurn(), 'Hi!');
    assert.equal(t.modelText, 'Hi!');
  });

  it('reports a control token as having no words', () => {
    const t = new CallTranscript();
    assert.equal(t.modelDelta('<ctrl46>').hasWords, false);
    assert.equal(t.modelDelta('Okay').hasWords, true);
  });

  it('bounds the safety window but keeps the whole call in the ledger', () => {
    const t = new CallTranscript();
    for (let i = 0; i < 100; i += 1) {
      t.userDelta(` sentence number ${i} is here`);
      t.takeUserTurn();
    }
    assert.ok(t.safetyWindow().length <= SAFETY_WINDOW_CHARS);
    assert.match(t.safetyWindow(), /number 99 is here$/);
    assert.match(t.userText, /^sentence number 0/);
  });
});

describe('safety bridge', () => {
  const control = { sessionMissing: false, syncTranscripts: async () => ({}), reportRisk: async () => ({}) };
  const trace = { add: () => {} };

  it('enters support once', () => {
    const bridge = new SafetyBridge(control, trace, 0);
    assert.deepEqual(bridge.verdict({ ok: true, action: 'stay_support', session_note: 'Stay.' }), { note: 'Stay.', urgent: false });
    assert.equal(bridge.verdict({ ok: true, action: 'stay_support' }), null);
    assert.equal(bridge.supporting, true);
  });

  it('treats legacy escalate and speak-first verdicts as imminent, never a pause', () => {
    for (const verdict of [
      { ok: true, action: 'escalate_pause', speak_first: true },
      { ok: true, action: 'crisis_freeze', terminal: true },
      { ok: true, action: 'stay_support', imminent: true },
    ]) {
      const outcome = new SafetyBridge(control, trace, 0).verdict(verdict);
      assert.equal(outcome.urgent, true, JSON.stringify(verdict));
    }
  });

  it('keeps going when the classifier could not be reached', () => {
    const bridge = new SafetyBridge(control, trace, 0);
    assert.equal(bridge.verdict({ ok: false, action: 'safety_unverified' }), null);
    assert.equal(bridge.supporting, false);
  });

  it('beats on its heartbeat', () => {
    const bridge = new SafetyBridge(control, trace, 0, 5_000);
    assert.equal(bridge.heartbeatDue(4_999), false);
    assert.equal(bridge.heartbeatDue(5_000), true);
  });
});

describe('call lifetime helpers', () => {
  it('renews ahead of expiry, never sooner than 5s', () => {
    assert.equal(renewDelayMs(new Date(100_000).toISOString(), 0), 55_000);
    assert.equal(renewDelayMs(new Date(10_000).toISOString(), 0), 5_000);
    assert.equal(renewDelayMs('not a date', 0), null);
  });

  it('rotates only when the server asks for it', () => {
    assert.equal(rotateDelayMs(0, 0, 0), null);
    assert.equal(rotateDelayMs(600, 0, 0), 600_000);
  });

  it('refuses an expired successor', () => {
    const grant = { token: 't', ws_url: 'w', new_session_expires_at: new Date(1_000).toISOString() };
    assert.equal(usableSuccessor(grant, 2_000), null);
    assert.equal(usableSuccessor(grant, 500), grant);
  });

  it('carries recent words into a replacement socket', () => {
    assert.equal(rollingContinuation('', ''), '');
    assert.match(rollingContinuation('my exam', 'good luck'), /Recent user: my exam[\s\S]*Do not greet/);
  });
});

describe('continuer words', () => {
  it('recognises "yeah" and "mm-hmm" in English and Arabic, but not a real turn', async () => {
    const { isBackchannel } = await import('../../frontend/src/voice/face/backchannel.ts');
    for (const word of ['yeah', 'mm-hmm', 'أيوه', 'نعم', 'okay.']) assert.equal(isBackchannel(word), true, word);
    for (const text of ['yeah but wait', 'I disagree with that plan', '']) assert.equal(isBackchannel(text), false, text);
  });
});

describe('listening reactions', async () => {
  const {
    ListenerReactor,
    PhraseDetector,
    nodOffset,
    reactionLook,
    NOD_GAP_MS,
    LOOK_GAP_MS,
    NOD_DIP_MS,
    PHRASE_PAUSE_MS,
    DOUBLE_NOD_SPEECH_MS,
  } = await import('../../frontend/src/voice/face/listenerReaction.ts');

  /** Feed `speechMs` of voice then `pauseMs` of silence, 20ms frames. */
  function speak(detector, start, speechMs, pauseMs) {
    const out = [];
    let t = start;
    for (; t < start + speechMs; t += 20) detector.frame(true, t);
    for (; t < start + speechMs + pauseMs; t += 20) {
      const phrase = detector.frame(false, t);
      if (phrase) out.push({ ...phrase, t });
    }
    return out;
  }

  it('finds a phrase ending from the voice alone, once, after a short pause', () => {
    const detector = new PhraseDetector();
    const phrases = speak(detector, 0, 1_500, 600);
    assert.equal(phrases.length, 1);
    assert.ok(Math.abs(phrases[0].speechMs - 1_480) <= 20);
    assert.ok(phrases[0].t - 1_480 >= PHRASE_PAUSE_MS, 'waits for the pause');
  });

  it('ignores gaps inside a word and too-short bursts', () => {
    const detector = new PhraseDetector();
    assert.equal(speak(detector, 0, 400, 100).length, 0, 'a 100ms gap is inside a word');
    assert.equal(speak(new PhraseDetector(), 0, 400, 600).length, 0, 'a cough is not a phrase');
  });

  it('nods at a phrase end and double-nods after a long one, without bobbing', () => {
    const reactor = new ListenerReactor();
    assert.equal(reactor.phraseEnd(1_200, 0).kind, 'nod');
    assert.equal(reactor.phraseEnd(1_200, NOD_GAP_MS - 1), null);
    assert.equal(reactor.phraseEnd(DOUBLE_NOD_SPEECH_MS, NOD_GAP_MS).kind, 'double_nod');
  });

  it('shows what the classifier read, in any language, at a calmer pace', () => {
    const reactor = new ListenerReactor();
    assert.equal(reactor.meaning('smile', 0, false).kind, 'smile');
    assert.equal(reactor.meaning('concern', LOOK_GAP_MS - 1, false), null);
    assert.equal(reactor.meaning('surprise', LOOK_GAP_MS, false).kind, 'ah');
    assert.equal(new ListenerReactor().meaning('curious', 0, false).kind, 'tilt');
    assert.equal(new ListenerReactor().meaning('none', 0, false), null);
    assert.equal(new ListenerReactor().meaning('dance', 0, false), null);
  });

  it('never smiles at someone in distress, but can show concern', () => {
    assert.equal(new ListenerReactor().meaning('smile', 0, true), null);
    assert.equal(new ListenerReactor().meaning('concern', 0, true).kind, 'concern');
  });

  it('draws a nod as a smooth dip that starts and ends at rest', () => {
    const nod = { kind: 'nod', at: 1_000, strength: 0.6 };
    assert.equal(nodOffset(nod, 1_000), 0);
    assert.ok(Math.abs(nodOffset(nod, 1_000 + NOD_DIP_MS / 2) - 0.6) < 1e-9, 'deepest in the middle');
    assert.equal(nodOffset(nod, 1_000 + NOD_DIP_MS), 0);
    const dip = NOD_DIP_MS * 0.8;
    assert.ok(nodOffset({ kind: 'double_nod', at: 0, strength: 1 }, dip * 1.5) > 0.5, 'a second dip');
    assert.ok(nodOffset({ kind: 'ah', at: 0, strength: 1 }, NOD_DIP_MS / 2) < 0, '"ah" lifts instead');
  });

  it('pairs looks with the reactions that need one', () => {
    assert.equal(reactionLook({ kind: 'smile', at: 0, strength: 1 }).expression, 'smile_eyes');
    assert.equal(reactionLook({ kind: 'ah', at: 0, strength: 1 }).expression, 'surprised');
    assert.equal(reactionLook({ kind: 'nod', at: 0, strength: 1 }), null);
  });

  it('has no word lists: the source matches no vocabulary', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../frontend/src/voice/face/listenerReaction.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(happy|sad|tired|great|wow)\b/i, 'no vocabulary in the reaction logic');
  });
});

describe('markers split across deltas', () => {
  it('never shows a half-sent marker as MindPal words', () => {
    const t = new CallTranscript();
    t.modelDelta('<no');
    t.noteModelAudio();
    assert.equal(t.currentModel, '');
    assert.equal(t.takeModelTurn(), '', 'cut off after "<no": nothing was said');
  });

  it('removes a marker completed in the next delta', () => {
    const t = new CallTranscript();
    t.modelDelta('Mm, <no');
    t.modelDelta('ise> I hear you.');
    t.noteModelAudio();
    assert.equal(t.takeModelTurn(), 'Mm, I hear you.');
  });

  it('keeps a real "<" the caller said mid-sentence', () => {
    const t = new CallTranscript();
    t.userDelta('three < four is true');
    assert.equal(t.takeUserTurn(), 'three < four is true');
  });
});

describe('thinking and reading looks', async () => {
  const { readingGaze, READING_LINE_MS, blendFaceLayers } = await import('../../frontend/src/voice/face/faceBlend.ts');
  const { ExpressionDirector } = await import('../../frontend/src/voice/face/expressionCommand.ts');
  const { eyeTalkFromSpeech } = await import('../../frontend/src/voice/face/eyeTalk.ts');

  it('reads line by line: a sweep across, a quick return, a small drop, always in range', () => {
    let lastX = -Infinity;
    for (let t = 0; t < READING_LINE_MS * 0.84; t += 20) {
      const { x } = readingGaze(t);
      assert.ok(x >= lastX, 'the sweep only moves forward');
      lastX = x;
    }
    for (let t = 0; t < READING_LINE_MS * 12; t += 17) {
      const { x, y } = readingGaze(t);
      assert.ok(Math.abs(x) <= 12 && Math.abs(y) <= 10, `out of gaze range at ${t}: ${x},${y}`);
    }
    assert.ok(readingGaze(READING_LINE_MS).y > readingGaze(0).y, 'next line is lower');
  });

  function face(expression, elapsedMs) {
    const speech = eyeTalkFromSpeech({ speaking: false, listening: false, modelTranscript: '', userTranscript: '', playbackEnvelope: 0, userEnvelope: 0 });
    const command = { expression, intensity: 1, durationMs: 20_000, startedAt: 0, source: 'state' };
    return blendFaceLayers({ speech, command, commands: [command], userTranscript: '', now: elapsedMs });
  }

  it('thinking looks up and aside, and keeps drifting instead of freezing', () => {
    const a = face('thinking', 500);
    const b = face('thinking', 2_500);
    assert.ok(a.gazeOverrideX > 4 && a.gazeOverrideY < -4, 'up and to the side');
    assert.notDeepEqual([a.gazeOverrideX, a.gazeOverrideY], [b.gazeOverrideX, b.gazeOverrideY]);
  });

  it('is allowed while the caller is distressed (calm looks only)', () => {
    const speech = eyeTalkFromSpeech({ speaking: false, listening: false, modelTranscript: '', userTranscript: '', playbackEnvelope: 0, userEnvelope: 0 });
    const command = { expression: 'reading', intensity: 1, durationMs: 20_000, startedAt: 0, source: 'state' };
    const out = blendFaceLayers({ speech, command, commands: [command], userTranscript: '', distress: true, now: 400 });
    assert.equal(out.commandName, 'reading');
  });

  it('a state is released by source without touching other looks', () => {
    const director = new ExpressionDirector();
    director.push({ expression: 'thinking', intensity: 1, durationMs: 20_000, startedAt: 0, source: 'state' });
    director.push({ expression: 'wink', intensity: 1, durationMs: 480, startedAt: 10, source: 'tool' });
    const after = director.release('state', 100);
    assert.ok(after.find((c) => c.expression === 'thinking').supersededAt === 100);
    assert.equal(after.find((c) => c.expression === 'wink').supersededAt, undefined);
  });
});

describe('the richer reaction vocabulary', async () => {
  const { kindFor, nodOffset, reactionLook } = await import('../../frontend/src/voice/face/listenerReaction.ts');

  it('draws laughing arcs and sparkles as closed, finite shapes', async () => {
    const { arcEyePoints, starEyePoints } = await import('../../frontend/src/voice/face/gaze.ts');
    for (const pts of [arcEyePoints(32, 22), starEyePoints(36, 42)]) {
      assert.ok(pts.length > 12);
      assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    }
    const arc = arcEyePoints(32, 22);
    assert.ok(Math.min(...arc.map((p) => p.y)) <= -10, 'the arch rises to the top');
    assert.ok(Math.max(...arc.map((p) => Math.abs(p.x))) <= 16.01, 'no wider than asked');
  });

  it('understands laugh, blush and sparkle requests', async () => {
    const { userFaceRequest } = await import('../../frontend/src/voice/face/expressionCommand.ts');
    assert.equal(userFaceRequest('can you laugh'), 'laugh');
    assert.equal(userFaceRequest('aww are you blushing'), 'blush');
    assert.equal(userFaceRequest('give me star eyes'), 'excited');
  });

  it('maps every classifier label', () => {
    assert.deepEqual(
      ['smile', 'laugh', 'surprise', 'concern', 'tender', 'excited', 'curious', 'none', 'dance'].map(kindFor),
      ['smile', 'laugh', 'ah', 'concern', 'tender', 'excited', 'tilt', null, null],
    );
    assert.equal(reactionLook({ kind: 'laugh', at: 0, strength: 1 }).expression, 'laugh');
    assert.equal(reactionLook({ kind: 'tender', at: 0, strength: 1 }).expression, 'soften');
    assert.equal(reactionLook({ kind: 'excited', at: 0, strength: 1 }).expression, 'excited');
  });

  it('a laugh bounces twice quickly; tenderness is one slow nod', () => {
    const laugh = { kind: 'laugh', at: 0, strength: 1 };
    assert.ok(nodOffset(laugh, 130) > 0 && nodOffset(laugh, 390) > 0, 'two bounces');
    assert.equal(nodOffset(laugh, 600), 0, 'over quickly');
    const tender = { kind: 'tender', at: 0, strength: 1 };
    assert.ok(nodOffset(tender, 390) > 0.7, 'deep in the middle of a slow nod');
    assert.equal(nodOffset({ kind: 'smile', at: 0, strength: 1 }, 100), 0, 'smiles are eyes only');
  });
});
