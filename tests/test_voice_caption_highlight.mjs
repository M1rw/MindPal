import test from "node:test";
import assert from "node:assert/strict";
import {
  findCaptionHighlightRange,
  normalizeCaptionHighlightRange,
} from "../frontend/js/voice/caption_highlight_policy.js";

test("highlight reveals the complete source while advancing only the spoken range", () => {
  const source = "Hello, it is good to hear from you.";
  const first = findCaptionHighlightRange(source, "Hello,", 0);
  assert.deepEqual(first, { start: 0, end: 6 });
  const second = findCaptionHighlightRange(source, "it is good", first.end);
  assert.deepEqual(second, { start: 7, end: 17 });
  assert.equal(source, "Hello, it is good to hear from you.");
});

test("highlight cursor does not jump backward for repeated words", () => {
  const source = "Yeah, yeah, I hear you.";
  const first = findCaptionHighlightRange(source, "Yeah,", 0);
  const second = findCaptionHighlightRange(source, "yeah,", first.end);
  assert.deepEqual(first, { start: 0, end: 5 });
  assert.deepEqual(second, { start: 6, end: 11 });
});

test("highlight falls back to the next meaningful token when spacing differs", () => {
  const source = "I hear you clearly.";
  assert.deepEqual(findCaptionHighlightRange(source, "hear   you", 0), { start: 2, end: 12 });
});

test("highlight policy preserves mixed Arabic-English source offsets", () => {
  const source = "أنا هنا مع you الآن.";
  const range = findCaptionHighlightRange(source, "you", 0);
  assert.deepEqual(range, { start: 11, end: 14 });
});

test("highlight range is clamped to the complete source", () => {
  assert.deepEqual(normalizeCaptionHighlightRange("hello", -3, 99), { start: 0, end: 5 });
});
