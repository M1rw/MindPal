# Voice Freshness and Delegation Provider Notes

## Production baseline

MindPal Voice currently runs on the production-validated `gemini-3.1-flash-live-preview` configuration through the `v1alpha` constrained Live WebSocket transport. The stable setup declares MindPal custom functions and retains the application-managed background `web_search` lane, including one-turn interruption grace.

Current, volatile facts in **text chat** are deterministically routed through verified web search. In the restored Voice baseline, the system prompt requires `web_search` before answering a current event, weather, price, score, elected-official, or other changing public fact. Voice must wait for the verified background-search update and must not answer from retained model knowledge.

## Deferred provider-native features

Google documents `gemini-2.5-flash-native-audio-preview-12-2025` with provider-native asynchronous functions, Google Search grounding, affective dialogue, and proactive audio. These preview-only capabilities were trialed in production on 2026-08-17 using a `v1beta` token/WebSocket migration.

That combined migration closed production Voice sessions immediately after setup. The browser reported a normal WebSocket close and the deployment reported no server-runtime exception, indicating a Live-session compatibility rejection rather than a microphone failure. The release was therefore rolled back to the last known-working Voice provider configuration.

> Provider-native Google Search grounding, `NON_BLOCKING` function-declaration behavior, `WHEN_IDLE` response scheduling, affective dialogue, and proactive audio are **not enabled** in the active release. They must not be re-enabled as a combined change. Each must first pass an authenticated end-to-end test against the production Google project, followed by a production startup check.

Code execution is not supported by the documented Gemini 3.1/2.5 Flash Live tool matrix. MindPal therefore uses the narrow, deterministic application-side `calculate_expression` tool for arithmetic instead of claiming provider-native code execution.

## Safe implementation consequences

1. Keep the text-chat verified-search gate for volatile facts.
2. Keep the Voice custom `web_search` background lane, explicit natural bridge, and one-turn interruption grace.
3. Keep the verified arithmetic tool and narrow, operation-specific future tool contracts.
4. Treat model/transport/API-version changes as a staged compatibility migration with an authenticated startup test before release.

## References

1. [Google AI for Developers — Tool use with Live API](https://ai.google.dev/gemini-api/docs/live-api/tools)
2. [Google AI for Developers — Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
3. [Google AI for Developers — Models](https://ai.google.dev/gemini-api/docs/models)
4. [Google AI for Developers — Function calling](https://ai.google.dev/gemini-api/docs/function-calling)

Last verified: 2026-08-17.
