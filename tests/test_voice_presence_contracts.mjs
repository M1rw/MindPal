import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripControlTokens, liveVoiceCaption, mergeLiveTranscript } from '../frontend/src/voice/session/caption.ts';
import { gestureFromDuplex } from '../frontend/src/voice/face/gesture.ts';
import { currentSpokenClause, talkCueFromSentence, eyeTalkFromSpeech } from '../frontend/src/voice/face/eyeTalk.ts';
import { isUserTurnFinal, parseLiveMessage } from '../frontend/src/voice/control/geminiLive.ts';
import { personaPalette } from '../frontend/src/voice/face/personaColor.ts';
import { SpringValue, htmlGazeTarget, HTML_GAZE_DAMPING, HTML_GAZE_RANGE_X, HTML_GAZE_RANGE_Y, HTML_GAZE_STIFFNESS } from '../frontend/src/voice/face/gaze.ts';
import { pcm16Rms } from '../frontend/src/voice/audio/playback.ts';
import { blendFaceLayers } from '../frontend/src/voice/face/faceBlend.ts';
import { commandFromToolArgs, commandFromUserRequest, ExpressionDirector, functionResponseMessage, moodFromToolArgs, parseFunctionCalls } from '../frontend/src/voice/face/expressionCommand.ts';
import { channelsOverlap } from '../frontend/src/voice/face/expressionCatalog.ts';
import { ProsodyTracker } from '../frontend/src/voice/face/prosody.ts';
import { AffectModel, STRAIN_CAP } from '../frontend/src/voice/face/affect.ts';

describe('Live captions', () => {
  it('uses live session text, not a canned supportive greeting', () => {
    const speaking = liveVoiceCaption({
      uiStatus: 'speaking',
      transcript: 'I had a hard day',
      aiTranscript: 'That sounds heavy.',
      crisisScript: '',
    });
    assert.equal(speaking, 'That sounds heavy.');

    const listening = liveVoiceCaption({
      uiStatus: 'listening',
      transcript: 'I had a hard day',
      aiTranscript: 'Hi there.',
      crisisScript: '',
    });
    assert.equal(listening, 'I had a hard day');

    const opening = liveVoiceCaption({
      uiStatus: 'listening',
      transcript: '',
      aiTranscript: 'Hi there.',
      crisisScript: '',
    });
    assert.equal(opening, 'Hi there.');

    const crisis = liveVoiceCaption({
      uiStatus: 'crisis_freeze',
      transcript: 'help',
      aiTranscript: 'Hi there.',
      crisisScript: 'The spoken reply is paused.',
    });
    assert.equal(crisis, 'The spoken reply is paused.');

    assert.equal(speaking.includes("I'm here to support you"), false);
    assert.equal(listening.includes("What's on your mind today"), false);
  });

  it('merges cumulative or delta output transcripts without doubling', () => {
    assert.equal(mergeLiveTranscript('', 'Hello'), 'Hello');
    assert.equal(mergeLiveTranscript('Hello', 'Hello there'), 'Hello there');
    assert.equal(mergeLiveTranscript('Hello there', 'Hello'), 'Hello there');
    assert.equal(mergeLiveTranscript('Hel', 'lo'), 'Hello');
  });
});

describe('Persona color and gestures', () => {
  it('maps session voice ids to distinct palettes', () => {
    const sulafat = personaPalette('Sulafat');
    const kore = personaPalette('Kore');
    const unknown = personaPalette('NotAVoice');
    assert.equal(sulafat.id, 'sulafat');
    assert.equal(kore.id, 'kore');
    assert.equal(unknown.id, 'default');
    assert.notDeepEqual(sulafat.stops[0], kore.stops[0]);
  });

  it('reacts while the model is silent without a hand pose', () => {
    const listening = gestureFromDuplex({
      floor: 'listening',
      userEnergy: 0.2,
      playbackEnergy: 0,
      userTranscript: 'work was a lot today',
      modelTranscript: '',
    });
    assert.equal(listening.pose, 'listening');
    assert.equal(listening.eyes.cue, 'listen');
    assert.ok(listening.nod > 0);
    assert.ok(listening.lean > 0);
    assert.ok(listening.beat > 0.1);
    assert.equal(listening.user, 0.2);
    assert.equal(listening.play, 0);

    const fromPartial = gestureFromDuplex({
      floor: 'listening',
      userEnergy: 0.15,
      playbackEnergy: 0,
      userTranscript: 'are you there?',
      modelTranscript: '',
    });
    assert.ok(fromPartial.nod > 0);
    assert.equal(fromPartial.eyes.cue, 'question');
    assert.equal(fromPartial.eyes.role, 'user');

    const speaking = gestureFromDuplex({
      floor: 'speaking',
      userEnergy: 0,
      playbackEnergy: 0.5,
      playbackBrightness: 0.7,
      userTranscript: '',
      modelTranscript: 'I am glad you said that.',
    });
    assert.equal(speaking.pose, 'speaking');
    assert.ok(speaking.beat > 0);
    assert.equal(speaking.eyes.cue, 'warmth');
    assert.equal(speaking.brightness, 0.7);

    const yielding = gestureFromDuplex({
      floor: 'yielding',
      userEnergy: 0,
      playbackEnergy: 0.4,
      playbackBrightness: 0.2,
      userTranscript: 'wait',
      modelTranscript: '',
    });
    assert.equal(yielding.pose, 'yielding');
    assert.ok(yielding.beat > 0);
    assert.equal(yielding.eyes.cue, 'speak');

    const crisis = gestureFromDuplex({
      floor: 'crisis_freeze',
      userEnergy: 0.9,
      playbackEnergy: 0.9,
      userTranscript: 'help',
      modelTranscript: '',
    });
    assert.equal(crisis.pose, 'crisis');
    assert.equal(crisis.beat, 0);
    assert.equal(crisis.eyes.cue, 'idle');

    const staying = gestureFromDuplex({
      floor: 'listening',
      userEnergy: 0.2,
      playbackEnergy: 0,
      userTranscript: 'i want to die tonight',
      modelTranscript: '',
      distress: true,
    });
    assert.notEqual(staying.pose, 'crisis');
    assert.ok(staying.beat > 0 || staying.nod > 0 || staying.face.distress);
    assert.notEqual(staying.face.expression, 'sleepy');
    assert.notEqual(staying.face.expression, 'roll_eyes');
  });
});

describe('HTML gaze math', () => {
  it('uses the reference spring, range, and clamp', () => {
    assert.equal(HTML_GAZE_RANGE_X, 12);
    assert.equal(HTML_GAZE_RANGE_Y, 10);
    assert.equal(HTML_GAZE_STIFFNESS, 0.05);
    assert.equal(HTML_GAZE_DAMPING, 0.85);

    const look = htmlGazeTarget(800, 80, 400, 300, 800, 600);
    assert.ok(look.x > 0);
    assert.ok(look.y < 0);
    assert.ok(look.x <= 12);
    assert.ok(look.y >= -10);

    const far = htmlGazeTarget(10000, 10000, 0, 0, 800, 600);
    assert.equal(far.x, 12);
    assert.equal(far.y, 10);

    const spring = new SpringValue(0, 0.05, 0.85);
    spring.set(12);
    spring.update();
    assert.ok(spring.current > 0 && spring.current < 12);
    assert.ok(spring.current < 1);
  });
});

describe('User endpoint vs model turnComplete', () => {
  it('does not treat a model turnComplete with audio as a user final', () => {
    const parsed = parseLiveMessage({
      serverContent: {
        turnComplete: true,
        modelTurn: { parts: [{ inlineData: { data: 'AAABAA==', mimeType: 'audio/pcm;rate=24000' } }] },
      },
    });
    assert.equal(parsed.turnComplete, true);
    assert.equal(isUserTurnFinal(parsed), false);
  });

  it('treats inputFinished as the user endpoint', () => {
    const parsed = parseLiveMessage({
      serverContent: { inputTranscription: { text: 'I had a hard day', finished: true } },
    });
    assert.equal(isUserTurnFinal(parsed), true);
  });

  it('surfaces generationComplete and goAway without treating them as a user endpoint', () => {
    const done = parseLiveMessage({ serverContent: { generationComplete: true } });
    assert.equal(done.generationComplete, true);
    assert.equal(isUserTurnFinal(done), false);
    const away = parseLiveMessage({ goAway: { timeLeft: '10s' } });
    assert.equal(away.goAway, true);
  });
});

describe('First model reply after a real user turn', () => {

  it('reports playback energy from PCM without requiring a fade', () => {
    const pcm = new Int16Array([0, 8000, -8000, 0]);
    assert.ok(pcm16Rms(pcm) > 0);
    assert.equal(pcm16Rms(new Int16Array()), 0);
  });
});

describe('Sentence-driven eye talk', () => {
  it('changes expression with the current clause, not one talking loop', () => {
    assert.equal(currentSpokenClause('Hello. How are you?'), 'How are you?');
    assert.equal(talkCueFromSentence('How are you?', 0.4), 'question');
    assert.equal(talkCueFromSentence('Hello,', 0.4), 'pause');
    assert.equal(talkCueFromSentence('I am glad you said that.', 0.4), 'warmth');
    assert.equal(talkCueFromSentence('That was a hard day.', 0.4), 'concern');
    assert.equal(talkCueFromSentence('It is really a lot.', 0.4), 'emphasis');
    assert.equal(talkCueFromSentence('The kettle is on', 0.4), 'speak');
    assert.equal(talkCueFromSentence('', 0), 'idle');

    const userQuestion = eyeTalkFromSpeech({
      speaking: false,
      listening: true,
      modelTranscript: '',
      userTranscript: 'how are you?',
      playbackEnvelope: 0,
      userEnvelope: 0.55,
    });
    const modelHere = eyeTalkFromSpeech({
      speaking: true,
      listening: false,
      modelTranscript: "I'm here.",
      userTranscript: '',
      playbackEnvelope: 0.5,
      userEnvelope: 0,
    });
    const silence = eyeTalkFromSpeech({
      speaking: false,
      listening: false,
      modelTranscript: '',
      userTranscript: '',
      playbackEnvelope: 0,
      userEnvelope: 0,
    });
    const rmsPeak = eyeTalkFromSpeech({
      speaking: true,
      listening: false,
      modelTranscript: 'The kettle is on',
      userTranscript: '',
      playbackEnvelope: 0.85,
      userEnvelope: 0,
    });
    const rmsQuiet = eyeTalkFromSpeech({
      speaking: true,
      listening: false,
      modelTranscript: 'The kettle is on',
      userTranscript: '',
      playbackEnvelope: 0.2,
      userEnvelope: 0,
    });
    assert.equal(userQuestion.cue, 'question');
    assert.equal(userQuestion.role, 'user');
    assert.equal(modelHere.cue, 'warmth');
    assert.equal(modelHere.role, 'model');
    assert.equal(silence.cue, 'idle');
    assert.equal(rmsPeak.cue, 'emphasis');
    assert.ok(rmsPeak.height < rmsQuiet.height);
    assert.ok(userQuestion.height !== modelHere.height);
    assert.ok(userQuestion.gazeNudgeX !== 0 || userQuestion.gazeNudgeY !== 0);

    const overlay = gestureFromDuplex({
      floor: 'listening',
      userEnergy: 0.4,
      playbackEnergy: 0.6,
      userTranscript: 'how are you?',
      modelTranscript: "I'm here.",
    });
    assert.equal(overlay.play, 0.6);
    assert.equal(overlay.user, 0.4);
    assert.equal(overlay.eyes.role, 'model');
    assert.ok(overlay.beat > 0.5);
  });
});

describe('Expression engine and prosody', () => {
  it('winks with independent lids and keeps speech underneath', () => {
    const now = 1_000_000;
    const wink = blendFaceLayers({
      speech: eyeTalkFromSpeech({
        speaking: true,
        listening: false,
        modelTranscript: "I'm here.",
        userTranscript: '',
        playbackEnvelope: 0.4,
        userEnvelope: 0,
      }),
      command: commandFromToolArgs({ expression: 'wink', intensity: 1 }, now),
      userTranscript: 'wink at me',
      crisis: false,
      now: now + 80,
    });
    assert.equal(wink.commandName, 'wink');
    assert.ok(wink.leftLid < 0.2);
    assert.ok(wink.rightLid > 0.8);
    assert.ok(wink.commandWeight > 0.5);
    assert.equal(wink.talkActive, true);

    const response = functionResponseMessage(
      parseFunctionCalls({ functionCalls: [{ id: '1', name: 'set_expression', args: { expression: 'wink' } }] }),
      [true],
    );
    assert.equal(response.toolResponse.functionResponses[0].response.result, 'ok');
    assert.equal(response.toolResponse.functionResponses[0].response.scheduling, 'SILENT');
    assert.equal(commandFromUserRequest('please wink at me').expression, 'wink');
  });

  it('blends commanded wink over listening without dropping user energy', () => {
    const now = 2_000_000;
    const overlay = gestureFromDuplex(
      {
        floor: 'listening',
        userEnergy: 0.4,
        playbackEnergy: 0,
        userTranscript: 'wink at me',
        modelTranscript: '',
        command: commandFromToolArgs({ expression: 'wink' }, now),
      },
      now + 60,
    );
    assert.equal(overlay.user, 0.4);
    assert.equal(overlay.face.commandName, 'wink');
    assert.ok(overlay.face.leftLid < overlay.face.rightLid);
  });

  it('moves energetic to flattening to perk-up from acoustic frames', () => {
    const tracker = new ProsodyTracker();
    let now = 5_000_000;
    let last = tracker.push(tonePcm(210, 0.9), 0.55, now);
    for (let i = 0; i < 80; i += 1) {
      now += 20;
      const burst = i % 4 === 0 ? 0.7 : 0.38;
      last = tracker.push(tonePcm(240 + (i % 7) * 18, burst), burst, now);
    }
    assert.equal(last.state, 'energetic');
    for (let i = 0; i < 420; i += 1) {
      now += 20;
      last = tracker.push(tonePcm(180, 0.55), Math.max(0.14, 0.3 - i * 0.0004), now);
    }
    assert.equal(last.state, 'flattening');
    for (let i = 0; i < 24; i += 1) {
      now += 20;
      last = tracker.push(tonePcm(220, 1), 0.78, now);
    }
    assert.equal(last.state, 'energetic');
  });

  it('suppresses sleepy looks during distress and crisis', () => {
    const now = 8_000_000;
    const sleepyCmd = commandFromToolArgs({ expression: 'sleepy', intensity: 1, duration_ms: 2000 }, now);
    const pain = blendFaceLayers({
      speech: eyeTalkFromSpeech({
        speaking: false,
        listening: true,
        modelTranscript: '',
        userTranscript: 'today was a hard day and I am scared',
        playbackEnvelope: 0,
        userEnvelope: 0.2,
      }),
      command: sleepyCmd,
      prosody: { state: 'flattening', energy: 0.12, shortLong: 0.7, f0Hz: 140, f0Var: 4, onsetHz: 0.8, turnMs: 9000, voiced: true },
      userTranscript: 'today was a hard day and I am scared',
      crisis: false,
      now: now + 100,
    });
    assert.equal(pain.distress, true);
    assert.notEqual(pain.commandName, 'sleepy');
    assert.ok(pain.leftLid > 0.85);
    assert.ok(pain.eyes.height > 40);

    const crisis = gestureFromDuplex({
      floor: 'crisis_freeze',
      userEnergy: 0.9,
      playbackEnergy: 0.9,
      userTranscript: 'help',
      modelTranscript: '',
      command: sleepyCmd,
      prosody: { state: 'flattening', energy: 0.2, shortLong: 0.6, f0Hz: 120, f0Var: 3, onsetHz: 0.5, turnMs: 8000, voiced: true },
    });
    assert.equal(crisis.pose, 'crisis');
    assert.equal(crisis.face.expression, 'neutral');
    assert.equal(crisis.beat, 0);
    assert.equal(crisis.face.commandWeight, 0);
  });

  it('keeps roll_eyes on gaze while talk channels stay active', () => {
    const now = 4_000_000;
    const roll = commandFromToolArgs({ expression: 'roll_eyes' }, now);
    const speech = eyeTalkFromSpeech({
      speaking: true,
      listening: false,
      modelTranscript: 'Sure, I can do that.',
      userTranscript: 'can u roll ur eyes for me',
      playbackEnvelope: 0.62,
      userEnvelope: 0,
    });
    const mid = blendFaceLayers({
      speech,
      command: roll,
      commands: [roll],
      userTranscript: 'can u roll ur eyes for me',
      crisis: false,
      now: now + 400,
    });
    const later = blendFaceLayers({
      speech,
      commands: [roll],
      userTranscript: 'can u roll ur eyes for me',
      crisis: false,
      now: now + 1400,
    });
    assert.equal(mid.commandName, 'roll_eyes');
    assert.equal(later.commandName, 'roll_eyes');
    assert.equal(mid.talkActive, true);
    assert.equal(later.talkActive, true);
    assert.ok(mid.gazeOverrideX !== null || mid.gazeOverrideY !== null);
    assert.ok(later.gazeOverrideX !== mid.gazeOverrideX || later.gazeOverrideY !== mid.gazeOverrideY);
    assert.ok(mid.eyes.height > 20);
    assert.equal(commandFromUserRequest('can u roll ur eyes for me').expression, 'roll_eyes');
    assert.equal(channelsOverlap('roll_eyes', 'wink'), false);
    assert.equal(channelsOverlap('wink', 'sleepy'), true);
  });

  it('queues compatible commands and crossfades same-channel supersede', () => {
    const now = 5_000_000;
    const director = new ExpressionDirector();
    const wink = commandFromToolArgs({ expression: 'wink', duration_ms: 800 }, now);
    const roll = commandFromToolArgs({ expression: 'roll_eyes' }, now + 40);
    const sleepy = commandFromToolArgs({ expression: 'sleepy', duration_ms: 2000 }, now + 80);
    director.push(wink, now);
    const both = director.push(roll, now + 40);
    assert.equal(both.length, 2);
    assert.ok(both.some((item) => item.expression === 'wink'));
    assert.ok(both.some((item) => item.expression === 'roll_eyes'));
    const after = director.push(sleepy, now + 80);
    const winkRow = after.find((item) => item.expression === 'wink');
    assert.ok(winkRow?.supersededAt === now + 80);
    const composed = blendFaceLayers({
      speech: eyeTalkFromSpeech({
        speaking: true,
        listening: false,
        modelTranscript: 'Okay.',
        userTranscript: '',
        playbackEnvelope: 0.5,
        userEnvelope: 0,
      }),
      commands: after,
      userTranscript: '',
      crisis: false,
      now: now + 160,
    });
    assert.equal(composed.talkActive, true);
    assert.equal(composed.commandName, 'sleepy');
    assert.ok(composed.gazeOverrideX !== null || composed.gazeOverrideY !== null);
  });

  it('integrates affect with asymmetric attack/release and caps strain', () => {
    const model = new AffectModel();
    const flattening = {
      state: 'flattening',
      energy: 0.12,
      shortLong: 0.7,
      f0Hz: 140,
      f0Var: 3,
      onsetHz: 0.4,
      turnMs: 8000,
      voiced: true,
    };
    const flat = [];
    for (let i = 0; i < 40; i += 1) {
      flat.push(model.tick({ prosody: flattening, dtMs: 50 }));
    }
    const held = flat[39];
    assert.ok(held.alertness >= 0.58);
    assert.ok(held.engagement >= 0.78);
    assert.ok(held.warmth >= 0.82);
    assert.equal(held.strain, 0);

    const steady = new AffectModel();
    const quiet = [];
    for (let i = 0; i < 40; i += 1) {
      quiet.push(steady.tick({ prosody: { ...flattening, state: 'quiet', turnMs: 0, energy: 0.04 }, dtMs: 50 }).alertness);
    }
    const beforePerk = quiet[39];
    assert.ok(beforePerk < quiet[0]);
    assert.ok(beforePerk > 0.38);
    const perked = steady.tick({
      prosody: { ...flattening, state: 'energetic', energy: 0.8, turnMs: 1200 },
      userEnergy: 0.82,
      dtMs: 50,
    }).alertness;
    assert.ok(perked - beforePerk > 0.08);

    const strained = new AffectModel();
    for (let i = 0; i < 12; i += 1) {
      strained.declare('firm', 1, { now: 1_000 + i * 500 });
    }
    assert.ok(strained.snapshot().strain > 0);
    assert.ok(strained.snapshot().strain <= STRAIN_CAP);
    assert.equal(moodFromToolArgs({ state: 'sleepy', intensity: 0.8 }).state, 'sleepy');
  });

  it('zeroes strain and stays attentive in distress and crisis', () => {
    const model = new AffectModel();
    model.declare('firm', 1);
    assert.ok(model.snapshot().strain > 0);
    const distress = model.tick({
      distress: true,
      userEnergy: 0.2,
      dtMs: 50,
      sessionMs: 4000,
    });
    assert.equal(distress.strain, 0);
    assert.ok(distress.warmth >= 0.7);
    assert.ok(distress.alertness >= 0.58);
    assert.ok(distress.engagement >= 0.65);

    const crisis = model.tick({ crisis: true, dtMs: 50 });
    assert.equal(crisis.strain, 0);
    assert.ok(crisis.alertness >= 0.58);

    const face = blendFaceLayers({
      speech: eyeTalkFromSpeech({
        speaking: false,
        listening: true,
        modelTranscript: '',
        userTranscript: 'I am scared and this pain is heavy',
        playbackEnvelope: 0,
        userEnvelope: 0.2,
      }),
      affect: crisis,
      command: commandFromToolArgs({ expression: 'sleepy' }, 9_000_000),
      userTranscript: 'I am scared and this pain is heavy',
      crisis: false,
      now: 9_000_080,
    });
    assert.equal(face.distress, true);
    assert.notEqual(face.commandName, 'sleepy');
    assert.notEqual(face.expression, 'sleepy');
  });
});

function tonePcm(hz, amp, samples = 320, sr = 16000) {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * amp * 30000);
  }
  return pcm;
}

describe('captions show what was said, not provider plumbing', () => {
  it('strips ASR control tokens that were rendering verbatim', () => {
    // `<ctrl46>` appeared on screen in the caption box, which is the one place
    // that claims to show exactly what was said.
    assert.equal(stripControlTokens('<ctrl46>'), '');
    assert.equal(stripControlTokens('hello <ctrl46> there'), 'hello  there');
    assert.equal(stripControlTokens('<|endoftext|>done'), 'done');
    assert.equal(stripControlTokens('أهلا <ctrl99> بك'), 'أهلا  بك');
  });

  it('does not eat a caller who actually says "less than"', () => {
    // Stripping every angle bracket would be the easy over-correction.
    assert.equal(stripControlTokens('2 < 3 and 5 > 4'), '2 < 3 and 5 > 4');
    assert.equal(stripControlTokens('the <b> tag'), 'the <b> tag');
  });

  it('keeps control tokens out of a merged caption', () => {
    let buffer = '';
    for (const delta of ['أنا', ' بخير', '<ctrl46>']) {
      buffer = mergeLiveTranscript(buffer, delta);
    }
    assert.equal(buffer, 'أنا بخير');
    assert.doesNotMatch(buffer, /ctrl/);
  });
});
