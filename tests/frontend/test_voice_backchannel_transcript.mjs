import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { useVoiceStore } from '../../frontend/src/store/voice.ts';

/**
 * The transcript from a real call:
 *
 *   You: Well, my to be honest, I want to tell you something
 *   You: strong with you and it is actually
 *   You: a weird because you know it is
 *   ...                                         (seven bubbles, one thought)
 */
describe('the call transcript reads like the conversation', () => {
  beforeEach(() => {
    useVoiceStore.setState({ turns: [] });
  });

  it('joins pauses in one thought into one bubble', () => {
    const { addTurn } = useVoiceStore.getState();
    addTurn('user', 'Well, to be honest, I want to tell you something');
    addTurn('user', 'strong with you and it is actually');
    addTurn('user', 'a weird because you know it is');
    const { turns } = useVoiceStore.getState();
    assert.equal(turns.length, 1);
    assert.equal(
      turns[0].text,
      'Well, to be honest, I want to tell you something strong with you and it is actually a weird because you know it is',
    );
  });

  it('never merges MindPal replies into each other or into the caller', () => {
    const { addTurn } = useVoiceStore.getState();
    addTurn('user', 'hello');
    addTurn('model', 'Good morning.');
    addTurn('model', 'How did it go?');
    assert.equal(useVoiceStore.getState().turns.length, 3);
  });
});

describe('there are no audible acknowledgments any more', () => {
  it('has no backchannel turn kind', () => {
    const { addTurn } = useVoiceStore.getState();
    useVoiceStore.setState({ turns: [] });
    addTurn('user', 'I want to tell you something');
    addTurn('model', 'Go on.');
    for (const turn of useVoiceStore.getState().turns) assert.equal('kind' in turn, false);
  });
});
