import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeCaptionWords,
  estimateCaptionDurationMs,
  getCaptionWordAtProgress,
} from "../frontend/js/voice/caption_word_timeline.js";

test("word timeline returns Unicode-safe word boundaries", () => {
  assert.deepEqual(tokenizeCaptionWords("أنا هنا with you"), [
    { text: "أنا", start: 0, end: 3 },
    { text: "هنا", start: 4, end: 7 },
    { text: "with", start: 8, end: 12 },
    { text: "you", start: 13, end: 16 },
  ]);
});

test("word timeline advances from first to last word by continuous progress", () => {
  const source = "Yeah, I hear you.";
  assert.equal(getCaptionWordAtProgress(source, 0).text, "Yeah");
  assert.equal(getCaptionWordAtProgress(source, 0.5).text, "hear");
  assert.equal(getCaptionWordAtProgress(source, 0.99).text, "you");
});

test("word timeline preserves repeated-word order", () => {
  const source = "yeah yeah go on";
  const first = getCaptionWordAtProgress(source, 0);
  const second = getCaptionWordAtProgress(source, 0.4);
  assert.equal(first.text, "yeah");
  assert.equal(second.text, "yeah");
  assert.notEqual(first.start, second.start);
});

test("word timeline estimates a usable duration for short responses", () => {
  assert.ok(estimateCaptionDurationMs("Hello there") >= 850);
});
