# Voice V4 Layer 2 — Pure Protocol and Lifecycle Core

**Status:** Layer 2 implementation scope only. This specification authorizes no WebSocket connection, microphone capture, playback, UI activation, provider token request, dynamic prompt behavior, feelings model, deployment, or production enablement.

## Responsibility

Layer 2 is a side-effect-free protocol core. It receives already-decoded JSON-shaped provider messages and converts them into normalized facts. It also validates protocol envelopes, builds the fixed setup and realtime-audio envelopes for later layers, and reduces lifecycle facts without opening a connection or making a UI decision.

## Normalized facts

The parser recognizes `setup_complete`, `model_audio_part`, `input_transcript`, `output_transcript`, `interrupted`, `generation_complete`, `turn_complete`, `go_away`, `session_resumption_update`, `provider_error`, `tool_call_unexpected`, and `unknown_message`. A single provider message may produce several facts. Every `serverContent.modelTurn.parts[*]` is inspected independently so audio and text are not mutually exclusive.

Audio parts are accepted only when the data is valid base64 and the MIME type is the contracted mono PCM16 little-endian 24 kHz form. The parser does not decode or play audio. Transcript facts are independent of audio facts; transcript existence never implies speaking state.

## Lifecycle reducer

The reducer consumes facts, not guesses. It tracks the setup barrier, session generation, completion markers, go-away notice, and the last safe protocol error. It does not transition to `ASSISTANT_SPEAKING` on received audio or output transcription. That state requires a later `playback_scheduled` fact from Layer 4. Likewise, `USER_SPEAKING` requires an explicit `capture_activity` fact from Layer 3.

`generation` is a hard fence. A fact from another generation is ignored and classified as `stale_generation`; stale callbacks cannot alter the current session state. An audio part before `setup_complete` is rejected as `audio_before_setup`.

## Provider boundary

The setup builder emits the fixed contract’s model and `AUDIO` response modality, plus the caller-supplied fixed instruction and voice. It does not add tools, memory, dynamic affect, or session-resumption behavior. The realtime-input builder accepts only a validated 16 kHz PCM16 base64 frame and produces a protocol envelope; it does not access a microphone.

## Safety boundary

Malformed messages never throw into the future session owner. They produce a bounded `unknown_message` or `provider_error` fact. Raw provider error messages, URLs, authorization data, token values, audio diagnostics, and transcript contents are never copied into diagnostics. Normalized facts may carry internal transcript text for a later policy layer, but no Layer 2 test, fixture, log, or diagnostic stores user transcript content.

## Exit criteria

Layer 2 is complete only when deterministic tests cover multipart audio-plus-transcript messages, every part independently, invalid base64, invalid MIME, setup ordering, transcript-only events, independent generation and turn completion, interruption, go-away, session resumption metadata without handles, unexpected tool calls, malformed input, invalid transitions, and stale-generation rejection. The tests must prove that no browser media API, playback API, WebSocket constructor, provider token request, or UI mutation exists in the Layer 2 modules.
