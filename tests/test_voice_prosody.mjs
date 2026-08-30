import assert from "node:assert/strict";
import test from "node:test";
import { createProsodyTracker } from "../frontend/js/features/voice/capture/prosody_tracker.js";

test("prosody tracker computes speech and silence durations accurately", () => {
  const events = [];
  const tracker = createProsodyTracker({
    frameMs: 20,
    speechThresholdRms: 0.02,
    onSpeech: (e) => events.push({ type: "speech", ...e }),
    onSilence: (e) => events.push({ type: "silence", ...e }),
  });

  // 3 frames of speech
  tracker.updateRms(0.05);
  tracker.updateRms(0.06);
  tracker.updateRms(0.04);

  let metrics = tracker.getMetrics();
  assert.equal(metrics.speechMs, 60);
  assert.equal(metrics.silenceMs, 0);
  assert.equal(metrics.isSpeaking, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "speech");

  // 4 frames of silence
  tracker.updateRms(0.005);
  tracker.updateRms(0.005);
  tracker.updateRms(0.005);
  tracker.updateRms(0.005);

  metrics = tracker.getMetrics();
  assert.equal(metrics.speechMs, 60);
  assert.equal(metrics.silenceMs, 80);
  assert.equal(metrics.isSpeaking, false);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "silence");
});

test("prosody tracker identifies filler bursts in user transcripts", () => {
  const fillers = [];
  const tracker = createProsodyTracker({
    onFiller: (f) => fillers.push(f),
  });

  tracker.scanFillers("I was thinking, um, maybe we should, uh, look into this");
  assert.equal(tracker.getMetrics().fillerCount, 2);
  assert.equal(fillers.length, 1);

  tracker.scanFillers("I was thinking, um, maybe we should, uh, look into this, hmm, let's see");
  assert.equal(tracker.getMetrics().fillerCount, 3);
  assert.equal(fillers.length, 2);
});
