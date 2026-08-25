import assert from "node:assert/strict";
import test from "node:test";

const { resolveVoiceCallSummaryState } = await import("../frontend/js/utils/voice_summary.js");

test("voice call without a summary or transcript renders a stable fallback instead of a stale loading label", () => {
  const state = resolveVoiceCallSummaryState({
    existingSummary: "",
    userTranscript: "",
    aiTranscript: "",
  });

  assert.deepEqual(state, { display: "Voice call", shouldSummarize: false });
});

test("voice call with transcript displays loading only while a summary can actually be generated", () => {
  const state = resolveVoiceCallSummaryState({
    existingSummary: "",
    userTranscript: "Hello",
    aiTranscript: "Hi there",
  });

  assert.deepEqual(state, { display: "Summarizing…", shouldSummarize: true });
});

test("failed summary generation falls back to a completed voice-call label", () => {
  const state = resolveVoiceCallSummaryState({
    existingSummary: "",
    userTranscript: "Hello",
    aiTranscript: "Hi there",
    summaryFailed: true,
  });

  assert.deepEqual(state, {
    display: "Voice call",
    shouldSummarize: false,
    summaryFailed: true,
  });
});

test("short persisted summaries remain visible without another summary request", () => {

  const state = resolveVoiceCallSummaryState({
    existingSummary: "Discussed feeling overwhelmed and chose a short break.",
    userTranscript: "",
    aiTranscript: "",
  });

  assert.deepEqual(state, {
    display: "Discussed feeling overwhelmed and chose a short break.",
    shouldSummarize: false,
  });
});
