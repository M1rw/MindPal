import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bandFor, CONFIRMATION_WINDOW_MS, IMMINENT_CONFIRMATIONS, IMMINENT_THRESHOLD, parseRiskArgs, RiskLatch, imminentStayNote, SUPPORT_THRESHOLD } from '../frontend/src/voice/safety/riskRating.ts';

describe('in-band risk rating', () => {
  it('maps ratings onto the same three bands the classifier uses', () => {
    assert.equal(bandFor(0), 'ordinary');
    assert.equal(bandFor(SUPPORT_THRESHOLD - 1), 'ordinary');
    assert.equal(bandFor(SUPPORT_THRESHOLD), 'support');
    assert.equal(bandFor(IMMINENT_THRESHOLD - 1), 'support');
    assert.equal(bandFor(IMMINENT_THRESHOLD), 'imminent');
    assert.equal(bandFor(10), 'imminent');
  });

  it('survives whatever the provider actually sends', () => {
    assert.deepEqual(parseRiskArgs({ risk: 8, kind: 'self_harm', reason: 'now' }), {
      risk: 8,
      kind: 'self_harm',
      reason: 'now',
    });
    // Models send numbers as strings often enough that this has to work.
    assert.equal(parseRiskArgs({ risk: '9' })?.risk, 9);
    assert.equal(parseRiskArgs({ risk: 42 })?.risk, 10, 'clamped');
    assert.equal(parseRiskArgs({ risk: -5 })?.risk, 0, 'clamped');
    assert.equal(parseRiskArgs({ risk: 5, kind: 'nonsense' })?.kind, 'unspecified');
    assert.equal(parseRiskArgs({}), null);
    assert.equal(parseRiskArgs({ risk: 'high' }), null, 'a word is not a rating');
  });

  it('does not pause on a single high rating', () => {
    const latch = new RiskLatch();
    const first = latch.note({ risk: 9, kind: 'self_harm', reason: '' });
    assert.equal(first.band, 'imminent');
    assert.equal(first.pause, false, 'one model opinion must not take the voice away');
    assert.equal(first.support, true, 'but it must slow the call down immediately');

    const second = latch.note({ risk: 8, kind: 'self_harm', reason: '' });
    assert.equal(second.pause, true);
    assert.equal(second.confirmations, IMMINENT_CONFIRMATIONS);
  });

  it('believes a downgrade immediately, because pausing is the expensive error', () => {
    const latch = new RiskLatch();
    latch.note({ risk: 9, kind: 'self_harm', reason: '' });
    const calmer = latch.note({ risk: 2, kind: 'unspecified', reason: 'was joking' });
    assert.equal(calmer.pause, false);
    assert.equal(calmer.band, 'ordinary');
    assert.equal(latch.pendingConfirmations, 0, 'streak cleared');

    // And the next high rating starts counting again from scratch.
    const again = latch.note({ risk: 9, kind: 'self_harm', reason: '' });
    assert.equal(again.pause, false);
  });

  it('does not combine a stale high rating with a much later one', () => {
    const latch = new RiskLatch();
    const t0 = 1_000_000;
    latch.note({ risk: 9, kind: 'self_harm', reason: '' }, t0);
    const later = latch.note(
      { risk: 9, kind: 'self_harm', reason: '' },
      t0 + CONFIRMATION_WINDOW_MS + 1,
    );
    assert.equal(later.pause, false, 'a rating from a different topic is not a confirmation');
    assert.equal(later.confirmations, 1);
  });

  it('keeps a peak for the receipt even after the rating drops', () => {
    const latch = new RiskLatch();
    latch.note({ risk: 8, kind: 'physical', reason: '' });
    latch.note({ risk: 1, kind: 'unspecified', reason: '' });
    assert.equal(latch.peakRisk, 8);
  });

  it('keeps the caller on the call and names immediate help', () => {
    // There is no crisis pause any more. A confirmed imminent rating keeps the
    // call open, and MindPal says out loud where help is right now.
    const note = imminentStayNote('self_harm');
    assert.ok(note.includes('[[MindPal]]'), 'must be labelled as an application note');
    assert.ok(note.includes('Do not read this note aloud'));
    assert.ok(/988/.test(note), 'names the crisis line');
    assert.ok(/emergency/i.test(note), 'names local emergency services');
    assert.ok(/Stay on this call/.test(note));
    assert.ok(/Do not end, pause, or leave the call/.test(note), 'the call is never cut off');
    assert.ok(/Never give methods/.test(note));
    assert.notEqual(imminentStayNote('physical'), imminentStayNote('self_harm'));
  });
});

