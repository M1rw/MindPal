# Gemini-only voice findings

Research date: 2026-08-21.

| Finding | Source |
|---|---|
| Gemini Live native-audio output supports the prebuilt voice name `Kore` in `speech_config.voice_config.prebuilt_voice_config.voice_name`. | Google, Live API capabilities guide: https://ai.google.dev/gemini-api/docs/live-api/capabilities |
| The Live API supports low-latency bidirectional voice, barge-in, audio transcriptions, tool use, proactive audio, and affective dialog. | Google, Live API overview: https://ai.google.dev/gemini-api/docs/live-api |
| Gemini 3.1 Flash Live uses `thinkingLevel`; Gemini 2.5 Live uses `thinkingBudget`. | Google, Live API capabilities guide. |
| Affective dialog and proactive audio are documented as unsupported for Gemini 3.1 Flash Live in the current capabilities guide; these options should not be treated as available in the V3 3.1 path. | Google, Live API capabilities guide. |
| Live API input is raw 16-bit PCM at 16 kHz and output is raw 16-bit PCM at 24 kHz over a stateful WebSocket. | Google, Live API overview. |
| Google documents client-to-server WebSocket with ephemeral tokens as a production approach, which matches the existing V3 token/transport boundary. | Google, Live API overview. |

Architecture conclusion: Kore and Charon are treated by this repository as Gemini prebuilt voice names and do not require CAMB IDs. The implementation configures the active Gemini session with the selected `voiceName` and routes normal responses plus approved short acknowledgement/thinking turns through that same session. CAMB is no longer a required dependency and is not constructed by the default V3 composition root.

The public capabilities documentation does not define a dedicated `mhm`/`yeah` backchannel API. V3 therefore uses a constrained, short `realtimeInput.text` cue intent on the active session, guarded by the conductor/orchestrator state machine, one response modality (`AUDIO`), and generation fencing. This is intentionally treated as a normal Gemini response turn with a backchannel lane, not as a second provider voice. Whether each requested voice name is accepted by the target deployed model remains a staging/human-review gate; no claim of live persona audio identity is made by automated tests.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Google Gemini Live API capabilities"
[2]: https://ai.google.dev/gemini-api/docs/live-api "Google Gemini Live API overview"
