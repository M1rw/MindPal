import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { browserDictationLang, recordingMimeType } from '../../frontend/src/utils/chat/dictation.ts';

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
