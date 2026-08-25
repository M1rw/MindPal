// frontend/js/utils/voice_summary.js

export function resolveVoiceCallSummaryState({
  existingSummary = "",
  userTranscript = "",
    aiTranscript = "",
  summaryFailed = false,
} = {}) {

  const summary = String(existingSummary || "").trim();
  const hasTranscript = Boolean(String(userTranscript || "").trim() || String(aiTranscript || "").trim());

  if (summary && summary.length <= 120) {
    return { display: summary, shouldSummarize: false };
  }

  if (hasTranscript && !summaryFailed) {
    return { display: "Summarizing…", shouldSummarize: true };
  }

  if (summaryFailed) {
    return { display: "Voice call", shouldSummarize: false, summaryFailed: true };
  }

  return { display: "Voice call", shouldSummarize: false };
}
