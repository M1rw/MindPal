import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { browserDictationLang, dictationLanguageHints, recordingMimeType, rememberSpoken } from '../../frontend/src/utils/chat/dictation.ts';

describe('dictation', () => {
  it('browser fallback listens in the chosen language, never a hard-coded en-US', () => {
    assert.equal(browserDictationLang('ar', 'en-US'), 'ar-SA');
    assert.equal(browserDictationLang('auto', 'ar-EG'), 'ar-EG');
    assert.equal(browserDictationLang(undefined, 'fr-FR'), 'fr-FR');
    assert.equal(browserDictationLang('auto', undefined), 'en-US');
  });

  it('records in a container the browser supports (webm on Chrome/Android, mp4 on Safari/iOS)', () => {
    assert.equal(recordingMimeType((t) => t.startsWith('audio/webm')), 'audio/webm;codecs=opus');
    assert.equal(recordingMimeType((t) => t === 'audio/mp4'), 'audio/mp4');
    assert.equal(recordingMimeType(() => false), '');
  });
});

describe('language hints for mixed-language voice notes', () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  };

  it('names the setting, the browser languages and languages dictated before', () => {
    const storage = memory();
    assert.deepEqual(dictationLanguageHints('auto', ['en-US', 'en'], storage), ['en-us', 'en']);
    // English first, then Arabic, in one note: once Arabic has been dictated, it is a hint from then on.
    rememberSpoken('Today was long. اليوم كان متعب', 'arabic', storage);
    assert.deepEqual(dictationLanguageHints('auto', ['en-US'], storage), ['en-us', 'ar']);
    assert.deepEqual(dictationLanguageHints('ar', ['en-US'], storage), ['ar', 'en-us']);
  });

  it('never sends junk, and survives blocked storage', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.doesNotThrow(() => rememberSpoken('اليوم', 'arabic', broken));
    assert.deepEqual(dictationLanguageHints('auto', ['en-US', '<script>', 'fr-FR'], broken), ['en-us', 'fr-fr']);
    assert.deepEqual(dictationLanguageHints(undefined, undefined, undefined), []);
  });
});
