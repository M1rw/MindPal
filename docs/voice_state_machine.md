# MindPal Voice State Machine

Purpose: keep browser voice input predictable and debuggable.

States:
- idle
- confirming_language
- preparing_mic
- listening
- stopping
- review
- no_speech
- heard_no_transcript
- network_error
- permission_error
- device_error
- generic_error
- unsupported

Rules:
- Waveform is visual only. It must never decide that the user is speaking.
- No-speech, network, device, generic, and unsupported states are terminal.
- Retry is the only transition from terminal error states back to recording.
- Cancel always aborts recognition, stops the mic stream, closes the inline panel, and returns to idle.
- Accept only works when transcript text exists; it appends transcript to the input and returns to idle.
- Web Speech onend with transcript goes to review.
- Web Speech onend without transcript goes to no_speech or heard_no_transcript.
- No auto-retry and no hidden restart loops.
