import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mergeLiveTranscript, stripControlTokens } from '../../frontend/src/voice/session/caption.ts';

/**
 * The provider puts ASR event markers in the transcript stream as if they were
 * words. A real call produced this session transcript:
 *
 *   "<noise> حبيبي يا حبيبتي Да? А вот. ماشي صعبه ..."
 *
 * `<noise>` was shown in the caption box, saved into the session transcript,
 * sent to the safety classifier, fed to the barge-in classifier, and 900ms later
 * became a user turn of its very own.
 */
describe('ASR event markers are not words', () => {
  it('removes the marker that reached a real caption box', () => {
    assert.equal(stripControlTokens('<noise>').trim(), '');
    assert.equal(stripControlTokens(' <noise>').trim(), '');
    assert.equal(stripControlTokens('<ctrl46>').trim(), '');
  });

  it('removes the shapes providers actually emit', () => {
    for (const marker of [
      '<noise>',
      '</noise>',
      '<noise/>',
      '<silence>',
      '<ctrl46>',
      '<ctrl 99 >',
      '<|endoftext|>',
      '[NOISE]',
      '[laughter]',
      '(inaudible)',
    ]) {
      assert.equal(stripControlTokens(marker).trim(), '', `${marker} survived`);
    }
  });

  it('leaves the caller own words alone', () => {
    const spoken = 'حبيبي يا حبيبتي';
    assert.equal(stripControlTokens(spoken), spoken);
    assert.equal(stripControlTokens('I said 3 < 5 and she agreed'), 'I said 3 < 5 and she agreed');
    assert.equal(stripControlTokens('[the plan] is fine'), '[the plan] is fine');
    assert.equal(stripControlTokens('a (long) pause'), 'a (long) pause');
  });

  it('keeps the words when a marker is mixed into real speech', () => {
    assert.equal(stripControlTokens('<noise> ماشي صعبه').trim(), 'ماشي صعبه');
    assert.equal(stripControlTokens('so [NOISE] anyway').replace(/\s+/g, ' ').trim(), 'so anyway');
  });

  it('never lets a marker into a running caption', () => {
    let caption = '';
    // Exactly the delta sequence from the trace.
    for (const delta of [' <noise>', ' حبيبي يا حبيبتي', ' Да? А вот.']) {
      caption = mergeLiveTranscript(caption, delta);
    }
    assert.ok(!caption.includes('<noise>'), `caption carried a marker: ${caption}`);
    assert.ok(caption.includes('حبيبي يا حبيبتي'), 'and the real speech survived');
  });
});

