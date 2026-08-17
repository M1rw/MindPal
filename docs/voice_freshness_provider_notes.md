# Voice Freshness and Delegation Provider Notes

## Verified provider capabilities

MindPal currently uses `gemini-3.1-flash-live-preview`. Google’s Live API tool documentation states that this model supports Google Search but supports **synchronous-only** function calling; provider-native asynchronous function calling is not available on this model.

Google documents `gemini-2.5-flash-native-audio-preview-12-2025` as Gemini 2.5 Flash Live, a native-audio bidirectional model. The Live API capability guide documents asynchronous function calls for the Gemini 2.5 Flash Live family, with `NON_BLOCKING` function declarations and response scheduling of `INTERRUPT`, `WHEN_IDLE`, or `SILENT`.

Google Search grounding is supported in the Live API and can be configured alongside custom function declarations. It allows the provider to search, synthesize, and cite current public web information. The general Grounding with Google Search documentation describes it as a mechanism for real-time content and cited, verifiable answers.

Code execution is not supported by the documented Gemini 3.1 or Gemini 2.5 Flash Live tool matrix. Arithmetic in live Voice should therefore use a narrow, deterministic application-side calculation tool rather than claim provider-native code execution.

## Implementation consequences

1. Current, volatile facts must be forced through verified search in text chat; the model must not answer from retained knowledge when search evidence is absent.
2. Live Voice should enable provider Google Search grounding for current facts.
3. Switching the Live session default to Gemini 2.5 Flash Live enables provider-native non-blocking custom functions, affective dialogue, and proactive audio, subject to preview-model operational monitoring.
4. Tool contracts should remain narrow and verb-first. Existing generic tools can be retained for continuity, but future integrations should use operation-specific names such as `check_order_status` or `book_appointment`.

## References

1. [Google AI for Developers — Tool use with Live API](https://ai.google.dev/gemini-api/docs/live-api/tools)
2. [Google AI for Developers — Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
3. [Google AI for Developers — Models](https://ai.google.dev/gemini-api/docs/models)
4. [Google AI for Developers — Function calling](https://ai.google.dev/gemini-api/docs/function-calling)

Last verified: 2026-08-17.
