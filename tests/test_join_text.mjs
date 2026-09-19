import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { joinText } from '../frontend/src/utils/ui/joinText.ts';

describe('joinText', () => {
  it('inserts a space between Latin sentences', () => {
    assert.equal(
      joinText('Hello, how are you?', 'I hope you are well.'),
      'Hello, how are you? I hope you are well.',
    );
  });

  it('inserts a space after ?! before the next utterance', () => {
    assert.equal(
      joinText('Hello, how are you?!', 'hope you are doing very well.'),
      'Hello, how are you?! hope you are doing very well.',
    );
  });

  it('does not insert an ASCII space between CJK sentences', () => {
    assert.equal(joinText('你好。', '我很好。'), '你好。我很好。');
  });

  it('does not double-space already-spaced inputs', () => {
    assert.equal(
      joinText('Hello, how are you? ', 'I hope you are well.'),
      'Hello, how are you? I hope you are well.',
    );
    assert.equal(
      joinText('Hello, how are you?', ' I hope you are well.'),
      'Hello, how are you? I hope you are well.',
    );
    assert.equal(
      joinText('Hello, how are you?  ', '  I hope you are well.'),
      'Hello, how are you? I hope you are well.',
    );
  });

  it('preserves user-typed newlines', () => {
    assert.equal(joinText('First line.\n', 'Second line.'), 'First line.\nSecond line.');
    assert.equal(joinText('First line.', '\nSecond line.'), 'First line.\nSecond line.');
  });

  it('keeps combining marks attached to the base letter', () => {
    const cafe = 'cafe\u0301';
    assert.equal(joinText(cafe, 'au lait'), `${cafe} au lait`);
    assert.equal(joinText(cafe, 'au lait').includes('\u0301'), true);
  });

  it('does not force a Latin space in Thai', () => {
    assert.equal(joinText('สวัสดี', 'ครับ'), 'สวัสดีครับ');
  });

  it('inserts a space after Arabic question mark before an Arabic letter', () => {
    assert.equal(joinText('كيف حالك؟', 'أنا بخير.'), 'كيف حالك؟ أنا بخير.');
  });

  it('returns the non-empty side when the other is empty', () => {
    assert.equal(joinText('', 'Hello'), 'Hello');
    assert.equal(joinText('Hello', ''), 'Hello');
    assert.equal(joinText('Hello', '', 'there'), 'Hello there');
  });
});

describe('dictation join wiring', () => {
  it('joins recognition chunks with joinText instead of naive concat', async () => {
    const source = await readFile(
      new URL('../frontend/src/hooks/chat/useChatInputDictation.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /import \{ joinText \} from '\.\.\/\.\.\/utils\/ui\/joinText'/);
    assert.match(source, /finalTranscript = joinText\(finalTranscript, transcript\)/);
    assert.match(source, /joinText\(recognitionAnchorRef\.current, speechChunk\)/);
    assert.doesNotMatch(source, /finalTranscript \+= transcript/);
    assert.doesNotMatch(source, /base \+ \(speechChunk \? separator/);
  });
});
