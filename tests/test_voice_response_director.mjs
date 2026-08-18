import assert from "node:assert/strict";
import test from "node:test";

import { buildVoiceResponsePlanBlock, selectVoiceResponsePlan } from "../frontend/js/voice/response_director.js";
import { buildAdaptiveVoicePrompt } from "../frontend/js/voice/prompts.js";

const baseState = (text, mood = "neutral") => ({
  _lastUserTranscript: text,
  _lastAiTranscript: "",
  _recentEmotionHint: mood,
  _contextProvider: { getMemoryLines: () => [], getRecentChat: () => [] },
});

test("Voice response director does not manufacture depth from a greeting", () => {
  const plan = selectVoiceResponsePlan({ lastUserTranscript: "hey" });
  assert.equal(plan.id, "social");
  assert.match(plan.instruction, /never manufacture depth/i);
});

test("Voice response director requires verified current facts rather than memory", () => {
  const plan = selectVoiceResponsePlan({ lastUserTranscript: "Who is the mayor of New York right now?" });
  assert.equal(plan.id, "verified_fact");
  assert.match(plan.instruction, /Do not guess/);
});

test("Voice response director turns a business dilemma into a bottleneck and one move", () => {
  const plan = selectVoiceResponsePlan({
    lastUserTranscript: "I have skills but I do not know where to sell them, and college is taking all my time.",
  });
  assert.equal(plan.id, "practical_conflict");
  assert.match(plan.instruction, /bottleneck or trade-off/);
  assert.match(plan.instruction, /this week/);
});

test("Voice response director turns emotionally loaded focus problems into a concrete conflict", () => {
  const plan = selectVoiceResponsePlan({
    lastUserTranscript: "I feel overwhelmed because I keep opening doors and I lose focus.",
    mood: "supportive",
  });
  assert.equal(plan.id, "practical_conflict");
  assert.match(plan.instruction, /bottleneck or trade-off/);
  assert.match(plan.instruction, /one next move/);
});

test("Voice response director answers direct questions first", () => {
  const plan = selectVoiceResponsePlan({ lastUserTranscript: "How should I price my first offer?" });
  assert.equal(plan.id, "direct_answer");
  assert.match(plan.instruction, /first sentence/);
});

test("Voice response director recognizes practical Egyptian Arabic", () => {
  const plan = selectVoiceResponsePlan({ lastUserTranscript: "أنا عندي مهارة بس مش عارف ألاقي عميل وأبيعها إزاي" });
  assert.equal(plan.id, "practical_conflict");
});

test("adaptive Voice prompt includes one explicit response plan and rejects scripted ritual", () => {
  const prompt = buildAdaptiveVoicePrompt("", "", baseState(
    "I keep building projects but I do not know who to sell to, and it feels like I build air.",
    "supportive",
  ));
  assert.match(prompt, /VOICE RESPONSE PLAN — practical_conflict/);
  assert.match(prompt, /Never force a fixed sequence/);
  assert.match(prompt, /Generic empathy is not a useful thing/);
  assert.match(prompt, /Do not manufacture depth from a simple greeting/);
  assert.match(buildVoiceResponsePlanBlock({ lastUserTranscript: "hello" }), /VOICE RESPONSE PLAN — social/);
});
