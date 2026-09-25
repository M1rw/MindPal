/**
 * The eyes morph between looks (capsule, heart, ^ arc, sparkle) instead of
 * swapping outlines: same point count, same start and direction, eased weights.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EyeMorph, MORPH_POINTS, outlineFor, resampleOutline } from '../../frontend/src/voice/face/eyeMorph.ts';
import { commandEnvelope } from '../../frontend/src/voice/face/expressionCommand.ts';

const area = (pts) => pts.reduce((sum, a, i) => { const b = pts[(i + 1) % pts.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;

describe('eye outlines line up for morphing', () => {
  it('every shape has the same number of points, clockwise, starting at the top centre', () => {
    for (const shape of ['capsule', 'heart', 'arc', 'star']) {
      const pts = outlineFor(shape, 30, 40, 12);
      assert.equal(pts.length, MORPH_POINTS, shape);
      assert.ok(area(pts) > 0, `${shape} runs the same way round`);
      // On the centre line, in the upper half: the top of a capsule, a heart's notch, an arc's crown.
      assert.ok(Math.abs(pts[0].x) < 1e-6 && pts[0].y < 0, `${shape} starts at the top centre (${JSON.stringify(pts[0])})`);
    }
  });

  it('resampling keeps points evenly spaced along the edge', () => {
    const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    const pts = resampleOutline(square, 8);
    const gaps = pts.map((p, i) => Math.hypot(pts[(i + 1) % 8].x - p.x, pts[(i + 1) % 8].y - p.y));
    assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1e-9);
  });
});

describe('a look morphs in instead of spawning', () => {
  it('passes through in-between outlines over a few hundred ms', () => {
    const morph = new EyeMorph();
    const capsule = morph.points(30, 40, 12);
    morph.update('heart', 16);
    const early = morph.weight('heart');
    assert.ok(early > 0 && early < 0.25, `first frame is only a little heart (${early})`);
    const mid = morph.points(30, 40, 12);
    const heart = outlineFor('heart', 30, 40, 12);
    const d = (a, b) => a.reduce((s, p, i) => s + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0);
    assert.ok(d(mid, capsule) > 0 && d(mid, heart) > 0, 'between the two shapes');
    for (let t = 0; t < 400; t += 16) morph.update('heart', 16);
    assert.ok(morph.weight('heart') > 0.97, 'fully a heart after ~0.4s');
    for (let t = 0; t < 400; t += 16) morph.update('capsule', 16);
    assert.ok(morph.weight('capsule') > 0.97, 'and melts back');
  });

  it('snaps under reduced motion', () => {
    const morph = new EyeMorph();
    morph.update('arc', 16, true);
    assert.equal(morph.weight('arc'), 1);
  });

  it('a reaction eases in rather than jumping on', () => {
    const command = { startedAt: 0, durationMs: 2000, intensity: 1 };
    const w = (t) => commandEnvelope(command, t);
    assert.ok(w(20) < 0.1, `barely there after 20ms (${w(20)})`);
    assert.ok(w(100) > 0.3 && w(100) < 0.7, 'halfway in at 100ms');
    assert.equal(w(250), 1);
    assert.ok(w(1990) < 0.05, 'eases out');
  });
});
