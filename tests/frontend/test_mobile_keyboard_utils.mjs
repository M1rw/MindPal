import test from 'node:test';
import assert from 'node:assert/strict';

import { getViewportMetrics } from '../../frontend/src/utils/mobile/viewport.ts';

test('keyboard offset is derived from the visual viewport gap', () => {
  const metrics = getViewportMetrics({
    innerHeight: 844,
    visualViewport: { height: 600 },
  });

  assert.equal(metrics.innerHeight, 844);
  assert.equal(metrics.visualHeight, 600);
  assert.equal(metrics.keyboardOffset, 244);
  assert.equal(metrics.effectiveHeight, 600);
});

test('keyboard offset does not go negative when no keyboard is open', () => {
  const metrics = getViewportMetrics({
    innerHeight: 800,
    visualViewport: { height: 800 },
  });

  assert.equal(metrics.keyboardOffset, 0);
  assert.equal(metrics.effectiveHeight, 800);
});
