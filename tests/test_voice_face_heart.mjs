import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { capsuleEyePoints, heartEyePoints } from '../frontend/src/voice/face/gaze.ts';
import {
  EXPRESSION_CHANNELS,
  EXPRESSION_POSES,
  FACE_EXPRESSIONS,
  isFaceExpression,
} from '../frontend/src/voice/face/expressionCatalog.ts';
import {
  commandFromToolArgs,
  commandFromUserRequest,
  userFaceRequest,
} from '../frontend/src/voice/face/expressionCommand.ts';

describe('heart eyes', () => {
  it('is a real expression the model and the caller can both ask for', () => {
    assert.ok(FACE_EXPRESSIONS.includes('heart'));
    assert.equal(isFaceExpression('heart'), true);
    assert.equal(EXPRESSION_POSES.heart.shape, 'heart');
    // Shape only: it must not drag the lids or gaze around with it.
    assert.deepEqual([...EXPRESSION_CHANNELS.heart], ['shape']);
  });

  it('holds long enough to be seen', () => {
    // A heart that blinks away reads as a rendering glitch, not an expression.
    assert.ok(EXPRESSION_POSES.heart.durationMs >= 2500, 'must not flash and vanish');
  });

  it('answers the way someone would actually ask, in either language', () => {
    for (const phrase of [
      'mindpal can you do a heart',
      'make a heart',
      'heart eyes please',
      'Can you draw a heart with your eyes?',
      'اعمل قلب',
      'ممكن قلوب',
    ]) {
      assert.equal(userFaceRequest(phrase), 'heart', `failed on: ${phrase}`);
    }
    const command = commandFromUserRequest('can you do a heart');
    assert.equal(command?.expression, 'heart');
    assert.equal(command?.source, 'user_request');
  });

  it('is drivable by the model through set_expression', () => {
    const command = commandFromToolArgs({ expression: 'heart', intensity: 1 });
    assert.equal(command?.expression, 'heart');
    assert.equal(command?.source, 'tool');
  });

  it('produces a closed silhouette the eye renderer can draw', () => {
    const pts = heartEyePoints(34, 32);
    assert.ok(pts.length > 20, 'enough points to look smooth');
    for (const p of pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'no NaN in the outline');
      assert.ok(Math.abs(p.x) <= 34, 'stays inside its width');
      assert.ok(Math.abs(p.y) <= 32, 'stays inside its height');
    }
    // A heart is wider at the top lobes than at the point.
    const top = pts.filter((p) => p.y < 0).reduce((m, p) => Math.max(m, Math.abs(p.x)), 0);
    const bottom = pts.filter((p) => p.y > 10).reduce((m, p) => Math.max(m, Math.abs(p.x)), 0);
    assert.ok(top > bottom, 'lobes wider than the point');
    // Same contract as the capsule it replaces.
    const capsule = capsuleEyePoints(34, 32, 10);
    assert.equal(typeof capsule[0].x, typeof pts[0].x);
  });
});
