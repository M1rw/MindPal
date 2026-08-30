import assert from "node:assert/strict";
import test from "node:test";
import { createEmotionEngine } from "../frontend/js/features/voice/orchestrator/emotion_engine.js";

test("emotion engine models user valence and arousal based on text sentiment and energy", () => {
  const engine = createEmotionEngine();

  const posEmotion = engine.analyzeUser("This is awesome and wonderful! I love it.", 0.1);
  assert.equal(posEmotion.label, "excited");
  assert.ok(posEmotion.valence > 0);
  assert.ok(posEmotion.arousal > 0);

  const negEmotion = engine.analyzeUser("I am feeling really sad and hurt today", 0.02);
  assert.equal(negEmotion.label, "sad");
  assert.ok(negEmotion.valence < 0);
});

test("emotion engine models AI empathetic and warm responses", () => {
  const engine = createEmotionEngine();

  const warmAi = engine.analyzeAi("I'm really glad to hear that! How can I help you further?");
  assert.equal(warmAi.label, "warm");

  const surpAi = engine.analyzeAi("Wow, that is unbelievable!");
  assert.equal(surpAi.label, "surprised");
});
