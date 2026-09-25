/**
 * Distress-safety contracts for the live orb face.
 * The face must never read as sleepy, bored, or dismissive while distress is held.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { blendFaceLayers } from '../../frontend/src/voice/face/faceBlend.ts';
import { gestureFromDuplex } from '../../frontend/src/voice/face/gesture.ts';
import { eyeTalkFromSpeech } from '../../frontend/src/voice/face/eyeTalk.ts';
import { commandFromToolArgs } from '../../frontend/src/voice/face/expressionCommand.ts';
import { AffectModel, SLEEPY_ALERTNESS, STRAIN_CAP } from '../../frontend/src/voice/face/affect.ts';
import { DistressLatch, DISTRESS_HOLD_MS, isAcousticDistress } from '../../frontend/src/voice/face/distress.ts';
import { MotionSpring } from '../../frontend/src/voice/face/motion.ts';
import { SpringValue } from '../../frontend/src/voice/face/gaze.ts';
import { layoutEyesInOrb, ORB_BASE_RADIUS } from '../../frontend/src/voice/face/layout.ts';
import { evaluateBackchannel, createBackchannelMemory } from '../../frontend/src/voice/face/backchannel.ts';

const FLATTENING = {
  state: 'flattening',
  energy: 0.24,
  shortLong: 0.72,
  f0Hz: 138,
  f0Var: 4,
  f0Slope: -2,
  onsetHz: 0.6,
  sinceOnsetMs: 900,
  turnMs: 9_000,
  voiced: true,
};

const QUIET_DISTRESS = {
  ...FLATTENING,
  state: 'steady',
  energy: 0.1,
  onsetHz: 0.8,
  turnMs: 4_000,
};

function listening(userTranscript = '') {
  return eyeTalkFromSpeech({
    speaking: false,
    listening: true,
    modelTranscript: '',
    userTranscript,
    playbackEnvelope: 0,
    userEnvelope: 0.18,
  });
}

describe('Flat affect never reads as drowsy', () => {
  it('keeps a flattening prosody state out of sleepy and tired, however long it lasts', () => {
    const model = new AffectModel();
    let levels = model.snapshot();
    for (let i = 0; i < 400; i += 1) {
      levels = model.tick({ prosody: FLATTENING, userEnergy: 0.2, dtMs: 50 });
    }
    assert.ok(levels.alertness > SLEEPY_ALERTNESS, `alertness ${levels.alertness}`);

    const face = blendFaceLayers({
      speech: listening('i just keep going through the motions'),
      prosody: FLATTENING,
      affect: levels,
      userTranscript: 'i just keep going through the motions',
      crisis: false,
      now: 10_000,
    });
    assert.equal(face.distress, true);
    assert.notEqual(face.expression, 'sleepy');
    assert.notEqual(face.expression, 'tired');
    assert.equal(face.expression, 'concerned');
  });

  it('does not let a long call soften alertness on its own', () => {
    const model = new AffectModel();
    let levels = model.snapshot();
    for (let i = 0; i < 600; i += 1) {
      levels = model.tick({ prosody: { ...FLATTENING, state: 'steady' }, userEnergy: 0.2, dtMs: 50 });
    }
    assert.ok(levels.alertness > SLEEPY_ALERTNESS + 0.2, `alertness ${levels.alertness}`);
  });

  it('treats a flat or quiet turn as distress evidence, not as background noise', () => {
    assert.equal(isAcousticDistress(FLATTENING), true);
    assert.equal(isAcousticDistress(QUIET_DISTRESS), true);
    assert.equal(isAcousticDistress({ ...FLATTENING, state: 'steady', energy: 0.3, turnMs: 900 }), false);
    assert.equal(isAcousticDistress(null), false);
  });
});

describe('Distress expression allowlist', () => {
  const suppressed = ['roll_eyes', 'side_eye', 'look_away', 'squint', 'blink_slow', 'amused', 'laugh', 'excited', 'blush', 'sleepy', 'tired', 'wink'];

  for (const expression of suppressed) {
    it(`suppresses ${expression} while distress is held`, () => {
      const now = 3_000_000;
      const face = blendFaceLayers({
        speech: listening('this hurt more than i expected'),
        command: commandFromToolArgs({ expression, intensity: 1, duration_ms: 2000 }, now),
        userTranscript: 'this hurt more than i expected',
        crisis: false,
        now: now + 200,
      });
      assert.equal(face.distress, true);
      assert.equal(face.commandName, '');
      assert.equal(face.commandWeight, 0);
      assert.equal(face.expression, 'concerned');
      assert.equal(face.gazeOverrideX, null);
      assert.equal(face.gazeOverrideY, null);
    });
  }

  it('still allows the supportive looks', () => {
    const now = 3_100_000;
    for (const expression of ['concerned', 'soften', 'neutral', 'smile_eyes', 'widen']) {
      const face = blendFaceLayers({
        speech: listening('today was hard'),
        command: commandFromToolArgs({ expression, intensity: 1, duration_ms: 2000 }, now),
        userTranscript: 'today was hard',
        crisis: false,
        now: now + 200,
      });
      assert.equal(face.distress, true);
      assert.equal(face.commandName, expression);
    }
  });

  it('keeps the lid and eye-height floors under a full-weight wink', () => {
    const now = 3_200_000;
    const wink = commandFromToolArgs({ expression: 'wink', intensity: 1, duration_ms: 480 }, now);
    const calm = blendFaceLayers({
      speech: listening('wink at me'),
      command: wink,
      userTranscript: 'wink at me',
      crisis: false,
      now: now + 120,
    });
    assert.ok(calm.leftLid < 0.2, 'wink still closes an eye outside distress');

    const distressed = blendFaceLayers({
      speech: listening('i am scared'),
      command: wink,
      userTranscript: 'i am scared',
      crisis: false,
      now: now + 120,
    });
    assert.equal(distressed.distress, true);
    assert.equal(distressed.leftLid, 1);
    assert.equal(distressed.rightLid, 1);
    assert.ok(distressed.eyes.height >= 56);
    assert.ok(distressed.leanAdd > 0);
  });

  it('leaves the crisis early-return absolute', () => {
    const crisis = gestureFromDuplex({
      floor: 'crisis_freeze',
      userEnergy: 0.9,
      playbackEnergy: 0.9,
      userTranscript: 'i want to kill myself',
      modelTranscript: '',
      command: commandFromToolArgs({ expression: 'sleepy', duration_ms: 2000 }, 4_000_000),
      prosody: FLATTENING,
    });
    assert.equal(crisis.face.expression, 'neutral');
    assert.equal(crisis.face.commandWeight, 0);
    assert.equal(crisis.face.distress, true);
    assert.equal(crisis.beat, 0);
  });
});

describe('Distress latching', () => {
  it('does not latch pause-facing distress from transcript words', () => {
    const latch = new DistressLatch();
    const t0 = 5_000_000;
    assert.equal(latch.noteText('i want to hurt myself', t0), false);
    assert.equal(latch.active(t0 + 500), false);
    assert.equal(latch.noteSupport(t0), true);
    assert.equal(latch.noteText('anyway what were you saying', t0 + 1_000), true);
    assert.equal(latch.active(t0 + DISTRESS_HOLD_MS - 1), true);
    assert.equal(latch.active(t0 + DISTRESS_HOLD_MS + 1), false);
  });

  it('holds acoustic evidence long enough to outlast frame-level flicker', () => {
    const latch = new DistressLatch();
    const t0 = 6_000_000;
    assert.equal(latch.noteProsody(FLATTENING, t0), true);
    assert.equal(latch.noteProsody({ ...FLATTENING, state: 'steady', energy: 0.4, turnMs: 300 }, t0 + 100), true);
    assert.equal(latch.active(t0 + 4_000), true);
    assert.equal(latch.active(t0 + 30_000), false);
  });

  it('never releases a crisis latch and resets only per call', () => {
    const latch = new DistressLatch();
    latch.noteCrisis();
    assert.equal(latch.active(9_999_999_999), true);
    assert.equal(latch.crisis, true);
    latch.reset();
    assert.equal(latch.active(0), false);
  });

  it('carries the latched flag into the face even when the visible transcript is calm', () => {
    const now = 7_000_000;
    const calm = blendFaceLayers({
      speech: listening('so anyway the bus was late'),
      command: commandFromToolArgs({ expression: 'look_away', duration_ms: 1800 }, now),
      userTranscript: 'so anyway the bus was late',
      crisis: false,
      now: now + 200,
    });
    assert.equal(calm.distress, false);
    assert.equal(calm.commandName, 'look_away');

    const latched = blendFaceLayers({
      speech: listening('so anyway the bus was late'),
      command: commandFromToolArgs({ expression: 'look_away', duration_ms: 1800 }, now),
      userTranscript: 'so anyway the bus was late',
      crisis: false,
      distress: true,
      now: now + 200,
    });
    assert.equal(latched.distress, true);
    assert.equal(latched.commandName, '');
    assert.equal(latched.gazeOverrideX, null);
  });

  it('suppresses backchannels on a quiet distressed turn, not just a lexical one', () => {
    const decision = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 8_000,
        transcript: 'and then i just stopped talking to anyone,',
        prosody: { ...QUIET_DISTRESS, f0Slope: -18, sinceOnsetMs: 300, turnMs: 8_000 },
        audibleEnabled: true,
        userEnergy: 0.14,
        now: 40_000,
      },
      createBackchannelMemory(),
    );
    assert.equal(decision.reason, 'distress');
    assert.equal(decision.visual, null);
    assert.equal(decision.audible, null);
  });
});

describe('Model-declared moods cannot escape the guard', () => {
  it('refuses to lower alertness or engagement while distress is latched', () => {
    const model = new AffectModel();
    const guard = { distress: true, now: 1_000 };
    const before = model.snapshot();
    const sleepy = model.declare('sleepy', 1, guard);
    assert.ok(sleepy.alertness >= before.alertness);
    assert.ok(sleepy.alertness > SLEEPY_ALERTNESS);

    const withdrawn = model.declare('withdrawn', 1, { distress: true, now: 2_000 });
    assert.ok(withdrawn.engagement >= 0.78);
    assert.equal(withdrawn.strain, 0);
    assert.ok(withdrawn.warmth >= 0.82);

    const firm = model.declare('firm', 1, { distress: true, now: 3_000 });
    assert.equal(firm.strain, 0);
    assert.ok(firm.warmth >= 0.82);
  });

  it('rate-limits repeated declarations so they cannot compound', () => {
    const model = new AffectModel();
    const first = model.declare('sleepy', 1, { now: 1_000 }).alertness;
    let last = first;
    for (let i = 1; i < 20; i += 1) {
      last = model.declare('sleepy', 1, { now: 1_000 + i * 20 }).alertness;
    }
    assert.equal(last, first, 'declarations inside the rate-limit window changed the level');
    const later = model.declare('sleepy', 1, { now: 1_000 + 5_000 }).alertness;
    assert.ok(later < first);
  });

  it('ignores declarations during crisis and holds the safety floor', () => {
    const model = new AffectModel();
    const crisis = model.declare('sleepy', 1, { crisis: true, now: 4_000 });
    assert.ok(crisis.alertness >= 0.58);
    assert.equal(crisis.strain, 0);
    assert.ok(crisis.engagement >= 0.78);
  });

  it('still allows a plain sleepy mood outside distress', () => {
    const model = new AffectModel();
    const sleepy = model.declare('sleepy', 1, { now: 5_000 });
    assert.ok(sleepy.alertness < model.snapshot().alertness + 0.001);
    assert.ok(sleepy.alertness < 0.62);
  });
});

describe('Acoustic agitation does not harden the face', () => {
  it('routes agitated to warmth and attention with no strain', () => {
    const model = new AffectModel();
    let levels = model.snapshot();
    for (let i = 0; i < 120; i += 1) {
      levels = model.tick({
        prosody: { ...FLATTENING, state: 'agitated', energy: 0.62, f0Var: 40, onsetHz: 8, turnMs: 3_000 },
        userEnergy: 0.6,
        dtMs: 50,
      });
    }
    assert.equal(levels.strain, 0);
    assert.ok(levels.warmth > 0.7);
    assert.ok(levels.engagement > 0.7);
    assert.ok(levels.strain <= STRAIN_CAP);
  });

  it('does not add strain on top of a mood that already declared it', () => {
    const model = new AffectModel();
    const firm = model.declare('firm', 1, { now: 1_000 }).strain;
    assert.ok(firm > 0);
    let levels = model.snapshot();
    for (let i = 0; i < 40; i += 1) {
      levels = model.tick({
        prosody: { ...FLATTENING, state: 'agitated', energy: 0.62, f0Var: 40, onsetHz: 8, turnMs: 3_000 },
        dtMs: 50,
      });
    }
    assert.ok(levels.strain < firm);
  });
});

describe('One NaN cannot blank the face', () => {
  it('recovers a motion spring and the HTML gaze spring from a NaN target', () => {
    const spring = new MotionSpring(0, 0.22, 0.62);
    spring.set(10);
    for (let i = 0; i < 20; i += 1) spring.update(16.67);
    const good = spring.update(16.67);
    assert.ok(Number.isFinite(good) && good > 1);
    spring.set(Number.NaN);
    spring.update(Number.NaN);
    for (let i = 0; i < 10; i += 1) spring.update(16.67);
    assert.ok(Number.isFinite(spring.update(16.67)));
    spring.set(0);
    for (let i = 0; i < 200; i += 1) spring.update(16.67);
    assert.ok(Math.abs(spring.update(16.67)) < 0.5);

    const gaze = new SpringValue(0, 0.05, 0.85);
    gaze.set(Number.NaN);
    for (let i = 0; i < 5; i += 1) gaze.update(16.67);
    assert.ok(Number.isFinite(gaze.update(16.67)));
    gaze.set(12);
    for (let i = 0; i < 300; i += 1) gaze.update(16.67);
    assert.ok(gaze.update(16.67) > 10);
    assert.equal(gaze.stiffness, 0.05);
    assert.equal(gaze.damping, 0.85);
  });

  it('lays out finite eyes from NaN geometry', () => {
    const layout = layoutEyesInOrb({
      radius: Number.NaN,
      cx: 140,
      cy: Number.NaN,
      width: Number.NaN,
      height: Number.NaN,
      spacing: Number.NaN,
      offsetY: Number.NaN,
      leftHeightMult: Number.NaN,
      rightHeightMult: Number.NaN,
      corner: Number.NaN,
      gazeX: Number.NaN,
      gazeY: Number.NaN,
      nod: Number.NaN,
      lean: Number.NaN,
      pulse: Number.NaN,
      scale: Number.NaN,
    });
    for (const value of [layout.radius, layout.cx, layout.cy, layout.corner]) {
      assert.ok(Number.isFinite(value), 'layout scalar went non-finite');
    }
    for (const slot of [layout.left, layout.right]) {
      for (const value of [slot.x, slot.y, slot.w, slot.h]) {
        assert.ok(Number.isFinite(value), 'eye slot went non-finite');
      }
      assert.ok(slot.w > 0 && slot.h > 0, 'eye collapsed to nothing');
    }
    assert.equal(layout.radius, ORB_BASE_RADIUS);
  });
});
