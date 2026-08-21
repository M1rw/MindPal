# Voice V3 Google evidence notes

Checked: 2026-08-21, official Google AI documentation.

## https://ai.google.dev/gemini-api/docs/live-api

- Live API is documented as low-latency, real-time voice and vision interaction with continuous audio/image/text streams.
- Official feature list includes barge-in, tool use, audio transcriptions for user input and model output, proactive audio, affective dialog, and multilingual support.
- Technical specification states input audio is raw 16-bit PCM, 16 kHz, little-endian; output audio is raw 16-bit PCM, 24 kHz, little-endian.
- Protocol is a stateful WebSocket connection (WSS).
- Google documents both server-to-server and client-to-server approaches and recommends ephemeral tokens instead of standard API keys for production client-to-server use.

## https://ai.google.dev/gemini-api/docs/live-api/capabilities

- Official model comparison page names Gemini 3.1 Flash Live Preview and Gemini 2.5 Flash Live Preview (the latter links to the native-audio model page).
- Gemini 3.1 uses `thinkingLevel` with minimal/low/medium/high and defaults to minimal for lowest latency.
- Gemini 2.5 uses `thinkingBudget`, with dynamic thinking enabled by default and `0` disabling thinking.
- Gemini 3.1 may include multiple content parts in one server event, including inline audio and transcript; clients must process all parts in each event.
- Gemini 2.5 delivers one content part per server event.
- Exact remaining capability table was truncated in the browser extraction and requires targeted extraction or additional official pages.

## Current MindPal implementation cross-check

- Frontend captures mono audio through `getUserMedia`, AudioWorklet preferred, 16 kHz PCM framing.
- Gemini adapter normalizes input/output transcription aliases and all provider events.
- Playback decodes provider PCM16 at 24 kHz and schedules it on a Web Audio clock.
- Production currently uses Gemini 3.1 Flash Live as primary and Gemini 2.5 Flash Native Audio as fallback.
- Provider-native backchannel behavior must remain capability-gated; the architecture requires a local deterministic fallback if official evidence does not prove native listening cues.

These notes are research data, not a final architecture document.
