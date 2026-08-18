import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptAssembler } from "../frontend/js/voice/transcript_assembler.js";

test("transcript assembler replaces cumulative snapshots instead of duplicating text", () => {
  const assembler = createTranscriptAssembler();
  assert.equal(assembler.append("hello"), "hello");
  assert.equal(assembler.append("hello there", { mode: "snapshot" }), "hello there");
  assert.equal(assembler.append("hello there"), "hello there");
});

test("transcript assembler appends delta chunks once", () => {
  const assembler = createTranscriptAssembler();
  assert.equal(assembler.append("مرحبا"), "مرحبا");
  assert.equal(assembler.append(" how are you"), "مرحبا how are you");
  assert.equal(assembler.append(" how are you"), "مرحبا how are you");
});

test("transcript assembler ignores duplicate keyed provider events", () => {
  const assembler = createTranscriptAssembler();
  assert.equal(assembler.append("one", { eventKey: "1" }), "one");
  assert.equal(assembler.append("two", { eventKey: "1" }), "one");
});

test("transcript assembler finalizes a mixed Arabic and English turn", () => {
  const assembler = createTranscriptAssembler();
  assembler.append("أنا أشعر");
  assert.equal(assembler.finalize(" anxious today"), "أنا أشعر anxious today");
});
