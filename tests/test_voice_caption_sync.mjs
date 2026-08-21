import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTION_CHARS_PER_SECOND,
  extractNovelTranscript,
  getCaptionReleaseSeconds,
  planPacedCaptionSegments,
  splitCaptionForPlayback,
} from '../frontend/js/voice/caption_sync_policy.js';
import { shouldPreserveCaptionQueueOnUserTranscript } from '../frontend/js/voice_live.js';

test('caption segments wait for the scheduled audio start and never release ahead of it', () => {
  const segments = planPacedCaptionSegments({
    text: 'Let me look into that carefully before I answer you.',
    audioStartTime: 12.4,
    nextCaptionTime: 0,
    now: 10,
  });

  assert.ok(segments.length >= 2);
  assert.equal(segments[0].startTime, 12.4);
  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(segments[index].startTime >= segments[index - 1].startTime + segments[index - 1].duration);
  }
});

test('caption pacing is deliberately conservative relative to spoken audio', () => {
  const text = 'This caption should take time to unfold because it follows the assistant voice.';
  const segments = splitCaptionForPlayback(text);
  const duration = segments.reduce((total, segment) => total + getCaptionReleaseSeconds(segment), 0);

  assert.ok(CAPTION_CHARS_PER_SECOND <= 16);
  assert.ok(duration >= text.length / CAPTION_CHARS_PER_SECOND - 0.25);
});

test('incremental provider transcripts only release novel caption text', () => {
  const first = extractNovelTranscript('', 'Good evening, Miljte');
  const cumulative = extractNovelTranscript(first.merged, 'Good evening, Miljte, how can I help?');
  const duplicate = extractNovelTranscript(cumulative.merged, 'Good evening, Miljte, how can I help?');

  assert.equal(first.delta, 'Good evening, Miljte');
  assert.equal(cumulative.delta, ', how can I help?');
  assert.equal(duplicate.delta, '');
});

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

test('caption planning respects already queued speech so later transcripts cannot overtake it', () => {
  const first = planPacedCaptionSegments({
    text: 'First spoken caption line.',
    audioStartTime: 4,
    now: 3,
  });
  const firstEnd = first.at(-1).startTime + first.at(-1).duration;
  const second = planPacedCaptionSegments({
    text: 'Second spoken caption line.',
    audioStartTime: 4,
    nextCaptionTime: firstEnd,
    now: 3,
  });

  assert.ok(second[0].startTime >= firstEnd);
});
