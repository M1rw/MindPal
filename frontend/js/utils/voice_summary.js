// frontend/js/utils/voice_summary.js

export function resolveVoiceCallSummaryState({
  existingSummary = "",
  userTranscript = "",
  aiTranscript = "",
} = {}) {
  const summary = String(existingSummary || "").trim();
  const hasTranscript = Boolean(String(userTranscript || "").trim() || String(aiTranscript || "").trim());

  if (summary && summary.length <= 120) {
    return { display: summary, shouldSummarize: false };
  }

  if (hasTranscript) {
    return { display: "Summarizing…", shouldSummarize: true };
  }

  return { display: "Voice call", shouldSummarize: false };
}
