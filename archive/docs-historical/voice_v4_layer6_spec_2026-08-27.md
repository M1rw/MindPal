# Voice V4 Layer 6 — UI, Consent, and Safe Diagnostics

**Status:** Layer 6 implementation scope only. Voice V4 remains disabled in production.

## Responsibility

Layer 6 is the presentation adapter over the approved Layer 0–5 contracts. It may bind the preserved voice overlay and microphone button, but it does not implement provider transport, microphone signal processing, playback, prompt adaptation, or feelings. It receives a session factory and feature snapshot through dependency injection.

## Release gate

The UI must remain inactive unless the evaluated `voice.live_v4` feature is enabled, the Layer 0 release decision is approved, and the environment is an explicitly protected non-production preview. A visible disabled state must explain that Voice is unavailable; it must not request microphone permission or instantiate a session.

The button and overlay are controlled by one UI owner. Repeated clicks while starting or active are ignored. On logout or feature-snapshot reset, the controller ends the session, clears captions and diagnostics, hides the overlay, and restores the archived inactive state.

## Consent

Microphone consent is per session and is never persisted by Layer 6. Opening the voice surface displays a clear consent panel explaining that the microphone is used for the current live conversation and that the user can end it at any time. Only an explicit “Allow microphone” action calls the session start path. “Not now” closes the panel without calling Layer 3.

## Truthful status

The UI label is derived only from approved lifecycle and playback facts. `MindPal is speaking` requires a playback-scheduled fact and an active playback source. An output transcript alone is a caption, not proof of audible output. `Listening` means the setup barrier has completed and capture is active. Errors stay visible until the user ends the session.

## Safe diagnostics

The UI diagnostics model accepts only Layer 0 allow-listed fields and bounded numeric counters. It displays state, context state, queue depth, active source count, sent/received/scheduled/drained counters, generation, event category, and safe error code. It strips tokens, URLs, PCM, transcripts, prompts, raw provider bodies, authorization values, and arbitrary unknown fields. Diagnostics are hidden by default and never persisted.

## Caption privacy

Captions are rendered only when the user enables the existing CC control. The Layer 6 diagnostic panel never includes caption text. Closing a session removes all caption DOM nodes and clears in-memory caption state.

## Exit criteria

Deterministic tests must prove the disabled gate never calls session creation, consent is explicit and non-persistent, lifecycle labels do not infer sound from transcripts, interruption and errors remain truthful, diagnostics are redacted, logout resets identity-bound state, and the preserved shell returns to inactive state. Production bundle verification must show no Voice V4 activation when the evaluated feature is disabled.
