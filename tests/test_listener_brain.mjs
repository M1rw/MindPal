import assert from "node:assert/strict";
import test from "node:test";
import { createListenerBrain } from "../frontend/js/features/voice/orchestrator/listener_brain.js";

test("listener brain identifies trailing clause hooks and unfinished sentences", () => {
  const brain = createListenerBrain();

  assert.equal(brain.looksUnfinished("I went to the store and then"), true);
  assert.equal(brain.looksUnfinished("He told me that so then"), true);
  assert.equal(brain.looksUnfinished("We were thinking because"), true);
  assert.equal(brain.looksUnfinished("I had a long meeting with my team and we decided everything"), true); // >6 words, no terminal punctuation
  assert.equal(brain.looksUnfinished("I had a meeting with my team and we decided everything."), false); // terminal period
  assert.equal(brain.looksUnfinished("What do you think?"), false); // terminal question
});

test("listener brain identifies thought completeness and closure phrases", () => {
  const brain = createListenerBrain();

  assert.equal(brain.isCompleteThought("Yeah that's it"), true);
  assert.equal(brain.isCompleteThought("And that was the end"), true);
  assert.equal(brain.isCompleteThought("I think we are good anyway"), true);
  assert.equal(brain.isCompleteThought("Yes."), true);
});

test("listener brain evaluates nudges on mid-story pauses and yields on completed thoughts", () => {
  const brain = createListenerBrain({
    nudgeSilenceMs: 1000,
    checkSilenceMs: 3000,
    endTurnSilenceMs: 500,
    backchannelCooldownMs: 0,
  });

  // Mid-story pause -> NUDGE
  const decision1 = brain.evaluate({
    prosody: { silenceMs: 1200, speechMs: 3000, fillerCount: 0 },
    userTranscript: "I was walking down the street and then",
    activityOpen: true,
  });
  assert.equal(decision1.action, "NUDGE");
  assert.equal(decision1.phrase, "mm?");

  // Complete thought + silence -> YIELD_TURN
  const decision2 = brain.evaluate({
    prosody: { silenceMs: 600, speechMs: 3000, fillerCount: 0 },
    userTranscript: "That's all I wanted to say.",
    activityOpen: true,
  });
  assert.equal(decision2.action, "YIELD_TURN");
});
