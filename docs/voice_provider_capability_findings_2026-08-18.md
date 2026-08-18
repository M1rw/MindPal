# Voice Provider Capability Findings — 2026-08-18

MindPal currently uses `gemini-3.1-flash-live-preview`. Official Gemini Live documentation confirms that this model supports continuous real-time audio, automatic VAD, input/output audio transcription, and barge-in. An interruption event is the correct server authority for cancelling queued playback. It also confirms that Gemini 3.1 accepts `clientContent` only for initial history seeding; post-setup text must use `realtimeInput.text`.

The same model comparison explicitly states that **proactive audio**, **affective dialogue**, and **asynchronous non-blocking function calling** are not supported by Gemini 3.1 Flash Live. Therefore, MindPal must not claim to provide unrestricted simultaneous back-channel speech such as "yeah" or "mm-hmm" while a person is still talking. It can honestly provide: a visibly present listening state while audio is streamed; immediate provider-controlled interruption; and a short spoken bridge after the provider declares a turn boundary, before a verified-fact/tool workflow begins.

| Product behavior | Provider-supported implementation |
|---|---|
| User interrupts MindPal | Use automatic VAD and the provider `interrupted` event; immediately fade/clear playback. |
| Long user thought | Keep the microphone streaming and display **Listening**; model acknowledgement must wait for a provider yield boundary. |
| Slow verified fact/tool work | Send exactly one short `realtimeInput.text` bridge after the user turn completes; retain audio input while the external check runs. |
| Changing the active voice | Not supported within an open session configuration; retain the selected voice through every transport resumption. |
| Proactive overlapping back-channel audio | Not available on the active Gemini 3.1 Flash Live provider and must not be simulated as a provider capability. |

## References

[1] [Gemini Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

[2] [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api)

[3] [Gemini Live API WebSocket reference](https://ai.google.dev/api/live)
