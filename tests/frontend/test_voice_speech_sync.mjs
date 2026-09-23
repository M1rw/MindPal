import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeCall } from './voice_call_harness.mjs';
import { SpeechTimeline, wordBoundary } from '../../frontend/src/voice/call/speechTimeline.ts';
import { SPEECH_TICK_MS } from '../../frontend/src/voice/call/callController.ts';

/**
 * Regression for: the face's reactions drifted away from MindPal's voice over a
 * reply ("not in sync till the end"). Tone checks ran one at a time, looks were
 * shown however late they came back, and sentence timing was a
 * characters-times-65ms guess instead of the audio.
 */

const T0 = 1_000_000;

describe('speech timeline', () => {
  it('places text on its audio whichever arrives first', () => {
    const textFirst = new SpeechTimeline();
    textFirst.text(20);
    assert.equal(textFirst.timeAt(10), Number.POSITIVE_INFINITY, 'no audio yet: not heard yet');
    textFirst.audio(1_000, T0, 1_000);

    const audioFirst = new SpeechTimeline();
    audioFirst.audio(1_000, T0, 1_000);
    audioFirst.text(20);

    for (const tl of [textFirst, audioFirst]) {
      assert.equal(tl.timeAt(10), T0 + 500);
      assert.equal(tl.spokenChars(T0 + 500), 10);
      assert.equal(tl.spokenChars(T0 + 2_000), 20);
    }
  });

  it('keeps a gap where the queue ran dry instead of stretching speech over it', () => {
    const tl = new SpeechTimeline();
    tl.audio(500, T0, 500);
    tl.audio(500, T0 + 2_000, 500);
    tl.text(10);
    assert.equal(tl.timeAt(7), T0 + 2_200);
    assert.equal(tl.spokenChars(T0 + 1_500), 5, 'nothing more is heard during the gap');
  });

  it('never splits a word between heard and not yet heard', () => {
    assert.equal(wordBoundary('hello there friend', 7), 11);
    assert.equal(wordBoundary('hello there friend', 0), 0);
    assert.equal(wordBoundary('hello', 3), 5);
  });
});

/** A classifier that answers MindPal's sentences after `delayMs` of call time. */
function slowClassifier(tones, delayMs, clockRef) {
  return (text, _context, speaker = 'caller') => {
    if (speaker !== 'mindpal') return Promise.resolve('none');
    return new Promise((resolve) => clockRef.clock.setTimeout(() => resolve(tones[text] ?? 'none'), delayMs));
  };
}

describe('the face stays on the voice to the end of a reply', () => {
  it('checks sentences in parallel and shows each look while its own sentence plays', async () => {
    const tones = {
      'Sentence one here. ': 'smile',
      'Sentence two here. ': 'concern',
      'Sentence six here. ': 'smile',
      'Sentence ten here. ': 'concern',
    };
    const trimmed = Object.fromEntries(Object.entries(tones).map(([k, v]) => [k.trim(), v]));
    const ref = {};
    const call = makeCall({ classify: slowClassifier(trimmed, 1_200, ref) });
    ref.clock = call.clock;
    await call.ready();
    const start = call.clock.now();
    for (const sentence of Object.keys(tones)) {
      call.transport.modelText(sentence);
      call.transport.audio(1_000);
    }
    call.transport.generationComplete();
    await call.advance(4_500);

    const looks = call.ui.lookTimes
      .filter(([at, look]) => at >= start && (look === 'smile_eyes' || look === 'concerned'))
      .map(([at, look]) => [at - start, look]);
    // Checks start SPEECH_CLASSIFY_GAP_MS apart (0, 250, 500, 750ms) and take 1.2s.
    // Sentence 1 (0-1s) is heard before its answer: dropped, not shown late.
    // Sentence 2 (1-2s) answers at ~1.45s, mid-sentence. 3 and 4 wait for their own audio.
    const near = (ms, target) => Math.abs(ms - target) <= SPEECH_TICK_MS + 40;
    assert.equal(looks.length, 3, JSON.stringify(looks));
    assert.ok(near(looks[0][0], 1_450) && looks[0][1] === 'concerned', JSON.stringify(looks));
    assert.ok(near(looks[1][0], 2_000) && looks[1][1] === 'smile_eyes', JSON.stringify(looks));
    assert.ok(near(looks[2][0], 3_000) && looks[2][1] === 'concerned', JSON.stringify(looks));
  });

  it('shows nothing after the voice has stopped, however late the check answers', async () => {
    const ref = {};
    const call = makeCall({ classify: slowClassifier({ 'That is great news!': 'smile' }, 1_500, ref) });
    ref.clock = call.clock;
    await call.ready();
    const before = call.ui.looks.length;
    call.transport.say('That is great news!', 600);
    await call.advance(3_000);
    assert.deepEqual(call.ui.looks.slice(before).filter((look) => look === 'smile_eyes'), []);
  });
});

describe('the caption reads along with the voice', () => {
  it('reports how much of the reply has been heard, then clears when it stops', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.modelText('Hello there my good friend. ');
    call.transport.audio(1_000);
    await call.advance(500);
    const caption = call.ui.outputCaption;
    assert.ok(call.ui.spoken > caption.length * 0.3 && call.ui.spoken < caption.length * 0.7, `${call.ui.spoken} of ${caption.length}`);
    call.transport.generationComplete();
    call.transport.turnComplete();
    await call.advance(400);
    // Generation finished at 0.5s but the audio runs to 1s: still tracking the
    // committed turn, not jumping to "all heard" when the text was complete.
    assert.ok(call.ui.spoken >= caption.length * 0.8 && call.ui.spoken < caption.length, `${call.ui.spoken} of ${caption.length}`);
    await call.advance(1_500);
    assert.equal(call.ui.spoken, null, 'cleared once playback is idle');
  });
});

describe('audit phase 2: voice client fixes', async () => {
  const { liveCallPreferences } = await import('../../frontend/src/voice/control/controlPlane.ts');
  const { useSettingsStore } = await import('../../frontend/src/store/index.ts');

  it('MP-22: heard progress never moves backwards when audio outruns its text', () => {
    const tl = new SpeechTimeline();
    tl.text(20);
    tl.audio(1_000, T0, 1_000);
    const before = tl.spokenChars(T0 + 900);
    assert.equal(before, 18);
    tl.audio(1_000, T0, 2_000); // more audio, no new text yet
    assert.ok(tl.spokenChars(T0 + 900) >= before);
    tl.reset();
    assert.equal(tl.spokenChars(T0 + 900), 0, 'a new turn starts from zero');
  });

  it('MP-20: the chosen voice, language and style go into the mint request', () => {
    useSettingsStore.getState().updateSettings({
      voiceModel: 'Puck',
      voiceLanguage: 'ar',
      personalization: { baseStyle: 'concise', warmth: 'direct' },
    });
    const prefs = liveCallPreferences();
    assert.equal(prefs.voice_id, 'Puck');
    assert.equal(prefs.voice_language, 'ar');
    assert.deepEqual(prefs.personalization, { baseStyle: 'concise', warmth: 'direct' });
    useSettingsStore.getState().updateSettings({ voiceLanguage: 'auto' });
    assert.equal(liveCallPreferences().voice_language, undefined, 'auto is no preference');
  });

  it('MP-21: sentence checks are paced to the server admission and all get a verdict', async () => {
    const ref = {};
    let lastAdmitted = Number.NEGATIVE_INFINITY;
    const verdicts = [];
    // The server's rule: one speaking-face check per 150ms per account, else "throttled".
    const classify = (text, _context, speaker = 'caller') => {
      if (speaker !== 'mindpal') return Promise.resolve('none');
      const now = ref.clock.now();
      if (now - lastAdmitted < 150) return Promise.resolve('throttled');
      lastAdmitted = now;
      verdicts.push(text);
      return Promise.resolve('smile');
    };
    const call = makeCall({ classify });
    ref.clock = call.clock;
    await call.ready();
    for (const s of ['One here. ', 'Two here. ', 'Three here. ', 'Four here. ']) {
      call.transport.modelText(s);
      call.transport.audio(1_500);
    }
    call.transport.generationComplete();
    await call.advance(2_000);
    // (The harness's greeting is checked first.)
    assert.deepEqual(verdicts.slice(-4), ['One here.', 'Two here.', 'Three here.', 'Four here.']);
  });
});
