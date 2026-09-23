import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EnergyNormalizer, compressEnergy, softKnee, EnvelopeFollower } from '../../frontend/src/voice/face/energy.ts';
import { SpringValue } from '../../frontend/src/voice/face/gaze.ts';
import { CueLock, MotionSpring, PoseMixer, SLEW_PER_FRAME, slewLimit } from '../../frontend/src/voice/face/motion.ts';
import { eyeExtentOutsideOrb, layoutEyesInOrb, ORB_BASE_RADIUS, clampRadius } from '../../frontend/src/voice/face/layout.ts';
import { createBackchannelMemory, evaluateBackchannel, gazeBackchannelSaccade, genuineNewSpeech, transitionRelevance } from '../../frontend/src/voice/face/backchannel.ts';
import { blendFaceLayers } from '../../frontend/src/voice/face/faceBlend.ts';
import { eyeTalkFromSpeech } from '../../frontend/src/voice/face/eyeTalk.ts';
import { gestureFromDuplex } from '../../frontend/src/voice/face/gesture.ts';
import { PlaybackQueue, scaleSpeechRms } from '../../frontend/src/voice/audio/playback.ts';
import { AFFECT_IDLE } from '../../frontend/src/voice/face/affect.ts';
import { EXPRESSION_POSES } from '../../frontend/src/voice/face/expressionCatalog.ts';
import { commandFromToolArgs } from '../../frontend/src/voice/face/expressionCommand.ts';

function extremeLayout(overrides = {}) {
  return layoutEyesInOrb({
    radius: clampRadius(ORB_BASE_RADIUS, 1, 4),
    cx: 140,
    cy: 140,
    width: 80,
    height: 160,
    spacing: 140,
    offsetY: -80,
    leftHeightMult: 2,
    rightHeightMult: 2.4,
    corner: 20,
    gazeX: 40,
    gazeY: 40,
    nod: 4,
    lean: 4,
    pulse: 1,
    scale: 1,
    ...overrides,
  });
}

describe('Adaptive energy and soft-knee blend', () => {
  it('maps loud and quiet talkers into a usable 0..1 range without a fixed ×12 ceiling', () => {
    const quiet = new EnergyNormalizer(40);
    const loud = new EnergyNormalizer(40);
    let quietOut = 0;
    let loudOut = 0;
    for (let i = 0; i < 40; i += 1) {
      quietOut = quiet.push(0.02 + (i % 3) * 0.004);
      loudOut = loud.push(0.35 + (i % 3) * 0.08);
    }
    assert.ok(quietOut > 0.35 && quietOut < 0.95);
    assert.ok(loudOut > 0.35 && loudOut < 1);
    assert.ok(compressEnergy(1, 0.2) < 1);
    assert.ok(scaleSpeechRms(0.08) > 0.5);
    assert.ok(scaleSpeechRms(0.02) > 0 && scaleSpeechRms(0.02) < 0.35);
    assert.ok(scaleSpeechRms(1) < 1);
    assert.ok(softKnee(2.4, 1) < 1);
    assert.ok(softKnee(0.4, 1) > 0.3);
  });

  it('normalizes additive face layers instead of summing past 1', () => {
    const now = 9_000_000;
    const perk = commandFromToolArgs({ expression: 'perk_up', intensity: 1 }, now);
    const mixed = blendFaceLayers({
      speech: eyeTalkFromSpeech({
        speaking: true,
        listening: false,
        modelTranscript: 'The kettle is on',
        userTranscript: '',
        playbackEnvelope: 1,
        userEnvelope: 1,
      }),
      affect: { ...AFFECT_IDLE, alertness: 1, engagement: 1, warmth: 1, strain: 0.42 },
      command: perk,
      userTranscript: '',
      crisis: false,
      now: now + 80,
    });
    assert.ok(mixed.nodAdd <= 0.7);
    assert.ok(mixed.eyes.height <= 78);
    assert.ok(mixed.eyes.width <= 34);
    assert.ok(EXPRESSION_POSES.perk_up.nod > 0);
  });
});

describe('Hard orb clamps under extreme input', () => {
  it('keeps every eye capsule inside the orb at RMS 1.0 and max layers', () => {
    const layout = extremeLayout();
    const radius = layout.radius;
    assert.equal(eyeExtentOutsideOrb(layout.left, 140, 140, radius) <= 0.3, true);
    assert.equal(eyeExtentOutsideOrb(layout.right, 140, 140, radius) <= 0.3, true);
    const speech = eyeTalkFromSpeech({
      speaking: true,
      listening: false,
      modelTranscript: 'The kettle is on really',
      userTranscript: '',
      playbackEnvelope: 1,
      userEnvelope: 1,
    });
    const gesture = gestureFromDuplex({
      floor: 'listening',
      userEnergy: 1,
      playbackEnergy: 1,
      userTranscript: 'a very long story about work today,',
      modelTranscript: '',
      affect: { alertness: 1, engagement: 1, strain: 0.42, warmth: 1 },
      backchannel: { kind: 'nod', strength: 1, at: 1 },
      engagementBoost: 0.38,
    });
    assert.ok(gesture.nod <= 0.72);
    assert.ok(gesture.lean <= 0.62);
    assert.ok(speech.height <= 78);
    assert.equal(layout.clipped || eyeExtentOutsideOrb(layout.left, 140, 140, radius) <= 0.3, true);
  });
});

describe('Slew limits and dt-aware springs', () => {
  it('caps per-frame jumps and matches 60Hz vs 120Hz spring travel', () => {
    assert.equal(slewLimit(0, 1, SLEW_PER_FRAME.nod) <= SLEW_PER_FRAME.nod, true);
    const beforeNod = 1.8;
    const afterNod = slewLimit(0, 1.8, SLEW_PER_FRAME.nod);
    assert.ok(afterNod < beforeNod);
    assert.ok(afterNod <= 0.09);

    const a = new SpringValue(0, 0.05, 0.85);
    const b = new SpringValue(0, 0.05, 0.85);
    a.set(12);
    b.set(12);
    for (let i = 0; i < 10; i += 1) a.update(16.67);
    for (let i = 0; i < 20; i += 1) b.update(8.335);
    assert.ok(Math.abs(a.current - b.current) < 0.35);

    const fast = new MotionSpring(0, 0.05, 0.85);
    fast.set(12);
    fast.update(16.67);
    assert.ok(fast.current > 0 && fast.current < 1);

    const mixer = new PoseMixer();
    mixer.tick('listening', 40, 280);
    assert.ok(mixer.weights.listening > 0 && mixer.weights.listening < 1);
    mixer.tick('crisis', 16, 0);
    assert.equal(mixer.weights.crisis, 1);
  });

  it('holds talk cues with hysteresis instead of flapping', () => {
    const lock = new CueLock('speak');
    assert.equal(lock.hold('question', 1000, 180), 'question');
    assert.equal(lock.hold('speak', 1050, 180), 'question');
    assert.equal(lock.hold('speak', 1300, 180), 'speak');
  });
});

describe('Long-turn backchannel gating', () => {
  it('fires visual and audible on a long turn with a TRP cue', () => {
    const mem = createBackchannelMemory();
    const prosody = {
      state: 'steady',
      energy: 0.22,
      shortLong: 0.7,
      f0Hz: 160,
      f0Var: 12,
      f0Slope: -18,
      onsetHz: 1.4,
      sinceOnsetMs: 260,
      turnMs: 6200,
      voiced: true,
    };
    const trp = transitionRelevance(prosody, 'and then the meeting ran long,');
    assert.ok(trp.score >= 2.5);
    assert.equal(trp.clauseBoundary, true);
    const decision = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 6200,
        transcript: 'and then the meeting ran long,',
        prosody,
        audibleEnabled: true,
        userEnergy: 0.4,
        now: 50_000,
      },
      mem,
    );
    assert.ok(decision.visual);
    assert.ok(decision.audible);
    assert.ok(decision.engagement > 0);

    const again = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 6300,
        transcript: 'and then the meeting ran long,',
        prosody,
        audibleEnabled: true,
        now: 50_400,
      },
      mem,
    );
    assert.equal(again.visual, null);
    assert.equal(again.audible, null);
  });

  it('does not fire during distress, crisis, model speech, or mid-word', () => {
    const base = {
      floor: 'listening',
      turnMs: 8000,
      transcript: 'this has been a hard day,',
      prosody: {
        state: 'steady',
        energy: 0.2,
        shortLong: 0.7,
        f0Hz: 140,
        f0Var: 8,
        f0Slope: -12,
        onsetHz: 1,
        sinceOnsetMs: 300,
        turnMs: 8000,
        voiced: true,
      },
      audibleEnabled: true,
      now: 80_000,
    };
    assert.equal(evaluateBackchannel({ ...base, distress: true }, createBackchannelMemory()).visual, null);
    assert.equal(evaluateBackchannel({ ...base, crisis: true }, createBackchannelMemory()).visual, null);
    assert.equal(evaluateBackchannel({ ...base, floor: 'speaking' }, createBackchannelMemory()).visual, null);
    const mid = evaluateBackchannel(
      {
        ...base,
        transcript: 'this has been going',
        prosody: { ...base.prosody, sinceOnsetMs: 40, shortLong: 1.2, voiced: true },
      },
      createBackchannelMemory(),
    );
    assert.equal(mid.reason, 'mid_word');
    assert.equal(mid.audible, null);
  });

  it('applies a real saccade offset on a gaze backchannel, not zero', () => {
    const left = gazeBackchannelSaccade(0.5, () => 0.2);
    const right = gazeBackchannelSaccade(0.5, () => 0.8);
    assert.ok(Math.abs(left.x) >= 6);
    assert.ok(Math.abs(right.x) >= 6);
    assert.notEqual(left.x, 0);
    assert.notEqual(right.x, 0);
    assert.equal(Math.sign(left.x), -1);
    assert.equal(Math.sign(right.x), 1);
    assert.equal(left.holdMs, 220);
  });

  it('never binds continuer PCM to the capture path', () => {
    assert.equal(new PlaybackQueue().playOverlay(new Int16Array(240)).captureBound, false);
    const queue = new PlaybackQueue();
    const result = queue.playOverlay(new Int16Array(32));
    assert.equal(result.captureBound, false);
    assert.equal(result.played, false);
  });

  it('keeps audible continuers off unless explicitly opted in', () => {
    const prosody = {
      state: 'steady',
      energy: 0.22,
      shortLong: 0.7,
      f0Hz: 160,
      f0Var: 12,
      f0Slope: -18,
      onsetHz: 1.4,
      sinceOnsetMs: 260,
      turnMs: 8000,
      voiced: true,
    };
    const visual = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 8000,
        transcript: 'and then the meeting ran long,',
        prosody,
        userEnergy: 0.5,
        now: 10_000,
      },
      createBackchannelMemory(),
    );
    assert.ok(visual.visual);
    assert.equal(visual.audible, null);

    const gated = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 8000,
        transcript: 'and then the meeting ran long,',
        prosody,
        audibleEnabled: true,
        overlayActive: true,
        userEnergy: 0.5,
        now: 10_000,
      },
      createBackchannelMemory(),
    );
    assert.equal(gated.audible, null);
    assert.equal(gated.reason, 'overlay_gate');
  });

  it('caps audible continuers per turn and requires genuine new speech', () => {
    assert.equal(genuineNewSpeech('a long story about work', 'a long story about work yeah'), false);
    assert.equal(genuineNewSpeech('a long story', 'a long story about the meeting after lunch,'), true);
    const mem = createBackchannelMemory();
    const prosody = {
      state: 'steady',
      energy: 0.22,
      shortLong: 0.7,
      f0Hz: 160,
      f0Var: 12,
      f0Slope: -18,
      onsetHz: 1.4,
      sinceOnsetMs: 260,
      turnMs: 8000,
      voiced: true,
    };
    const first = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 8000,
        transcript: 'and then the meeting ran long,',
        prosody,
        audibleEnabled: true,
        userEnergy: 0.4,
        now: 20_000,
      },
      mem,
    );
    assert.ok(first.audible);
    const second = evaluateBackchannel(
      {
        floor: 'listening',
        turnMs: 9000,
        transcript: 'and then the meeting ran long, and then we kept going after lunch,',
        prosody: { ...prosody, turnMs: 9000 },
        audibleEnabled: true,
        userEnergy: 0.4,
        now: 40_000,
      },
      mem,
    );
    assert.equal(second.audible, null);
  });

});

describe('Envelope follower smoothness', () => {
  it('does not jump from 0 to 1 in one tick', () => {
    const env = new EnvelopeFollower(0.38, 0.14);
    const first = env.push(1, 16.67);
    assert.ok(first < 0.5);
    let maxDelta = 0;
    let prev = first;
    for (let i = 0; i < 12; i += 1) {
      const next = env.push(1, 16.67);
      maxDelta = Math.max(maxDelta, Math.abs(next - prev));
      prev = next;
    }
    assert.ok(maxDelta < 0.45);
  });
});
