import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldPreserveCaptionQueueOnUserTranscript } from '../frontend/js/voice_live.js';

test('partial user transcription does not erase pending assistant captions before provider interruption', () => {
  assert.equal(shouldPreserveCaptionQueueOnUserTranscript(), true);
  assert.equal(shouldPreserveCaptionQueueOnUserTranscript({ providerInterrupted: false }), true);
  assert.equal(shouldPreserveCaptionQueueOnUserTranscript({ providerInterrupted: true }), false);
});

test('user transcript callbacks do not create a second assistant caption node', () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/js/voice_live.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /captionTurnComplete = true;\s*currentCaption = null;/);
});
