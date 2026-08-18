import test from "node:test";
import assert from "node:assert/strict";

import { classifyFinalizedVoiceTurn } from "../frontend/js/voice/intent/finalized_turn_router.js";

test("finalized router sends current facts through strict evidence", () => {
  const plan = classifyFinalizedVoiceTurn({ text: "What is the latest weather in Cairo?" });
  assert.equal(plan.kind, "current-fact");
  assert.equal(plan.operation.strictEvidence, true);
  assert.equal(plan.operation.evidenceQuery, "What is the latest weather in Cairo?");
});

test("finalized router routes memory and calculations to trusted tools", () => {
  const memory = classifyFinalizedVoiceTurn({ text: "Do you remember my goals?" });
  assert.equal(memory.kind, "memory");
  assert.equal(memory.operation.tool, "search_memory");

  const calculation = classifyFinalizedVoiceTurn({ text: "Can you calculate 18 * 7?" });
  assert.equal(calculation.kind, "calculation");
  assert.equal(calculation.operation.tool, "calculate_expression");
  assert.equal(calculation.operation.args.expression, "18 * 7");
});

test("finalized router handles research, local time, and ordinary conversation separately", () => {
  assert.equal(classifyFinalizedVoiceTurn({ text: "Please research the history of stoicism" }).kind, "research");
  assert.equal(classifyFinalizedVoiceTurn({ text: "What time is it right now?" }).kind, "local-time");
  assert.equal(classifyFinalizedVoiceTurn({ text: "I had a long day and need to talk" }).kind, "conversation");
});
