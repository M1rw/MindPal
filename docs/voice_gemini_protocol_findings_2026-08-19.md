# Gemini Live Protocol Findings — 2026-08-19

## Official facts used in this audit

Google’s current Live API overview states that Live supports low-latency streaming, barge-in, audio transcriptions for both input and output, raw 16-bit PCM input at 16 kHz, raw 16-bit PCM output at 24 kHz, and a stateful WebSocket transport.[1]

The current capabilities guide states that Gemini 3.1 Flash Live can place multiple content parts in one server event, including inline audio and transcription, so the client must process all parts in each event. It also distinguishes client-content semantics: for Gemini 3.1, `send_client_content` is for initial context seeding, while post-setup text should use realtime input. Gemini 2.5 continues to support client content during the conversation.[2]

The same guide documents `outputAudioTranscription: {}` and `inputAudioTranscription: {}` at the setup root for enabling output and input transcripts while keeping `responseModalities: [AUDIO]`. It shows output transcripts at `serverContent.outputTranscription.text`, input transcripts at `serverContent.inputTranscription.text`, and audio at `serverContent.modelTurn.parts[].inlineData`.[2] [3]

Google’s VAD guidance says that an interruption cancels and discards the ongoing generation and that clients should stop playback and clear queued playback when `serverContent.interrupted` is true. It also says that when an audio stream is paused for more than a second, such as microphone mute, an `audioStreamEnd` event should be sent to flush cached audio.[2]

## Relevance to the trace

The user trace shows the implementation receives separate output transcript and audio events, but it emits many `playback.started` events because each PCM chunk is scheduled as its own Web Audio source. This is not itself a protocol violation; it is an application-level event-granularity issue.

The trace also shows cue requests followed by timeouts and later main answer chunks classified as `backchannel`. The protocol facts above support two fixes: cue requests must be registered and correlated before sending realtime text, and the classifier must never use phrase matching or a global flag to label normal answer audio. Only an explicitly pending cue request for the current response may classify the cue.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api "Gemini Live API overview"

[2]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capabilities guide"

[3]: https://github.com/google-gemini/live-api-web-console/issues/111 "Google Gemini Live API transcription issue discussion"
