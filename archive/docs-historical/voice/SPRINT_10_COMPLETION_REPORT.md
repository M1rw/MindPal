# MindPal Voice V3 — Sprint 10 Completion Report

## Status

Sprint 10 is implemented in the isolated `voice-v3/` engine. The production V2 frontend path remains unchanged. An additive authenticated backend route was added at `POST /api/voice/v3/tts` to satisfy the client contract and normalize existing backend TTS output to mono 24 kHz PCM16.

## Delivered

`RealtimeTTSProvider` is now the primary real-mode verbal cue provider. It accepts cue text, persona, emotion, generation identity, and cue ID. It sends the exact `{ text, persona, emotion, format: "pcm16", sampleRate: 24000 }` request to the backend, attaches Firebase Authorization and App Check headers when available, applies a bounded 180 ms network timeout, caches repeated persona/emotion/cue combinations, uses an injected preloaded local WASM/Piper-style adapter when the network path is slow or unavailable, and produces a short gender-neutral hum as the final non-verbal fallback.

`BackchannelConductor` now detects a pause from capture RMS decay, starts background TTS prefetch at 150 ms, stores the generated chunk in a pending cue buffer, approves it at the 600 ms boundary if the user remains silent and the main lane is idle, and discards it immediately when speech resumes or a turn/final transcript/main-lane event invalidates it. Existing Sprint 5 synthetic-provider behavior remains compatible for deterministic tests.

The composition root and `IntegrationManager` select realtime TTS in real mode and synthetic cues only in mock mode. The React hook can configure persona, emotion, and an injected local TTS adapter. The debug panel now exposes TTS provider state, pending buffer state, and predictive prefetch latency. `DEBUG_TTS` follows the existing V3 debug flag convention.

The backend route validates the request, requires authentication, reuses the existing TTS service, applies a bounded common-cue cache, parses signed 16-bit PCM WAV output, resamples to 24 kHz, downmixes multichannel audio, and returns the exact `{ audioBase64, durationMs }` response shape.

`INTEGRATION_GUIDE.md` documents the endpoint contract, authentication, backend cache expectations, local WASM adapter setup, predictive timing, static/synthetic fallback policy, and rollout checks.

## Validation evidence

The exact V3 validation command passed:

```text
npm run check  — passed
npm test       — 11 test files, 54 tests passed
npm run build  — passed; Vite production output generated
```

The existing backend suite also passed:

```text
pytest -q     — 177 passed, 1 warning
py_compile    — passed for backend/api/voice_router.py
```

The sandbox did not have the `ruff` executable installed, so linting was not run; the backend source was bytecode-compiled and covered by the full existing test suite.

## Production prerequisites

The backend route is implemented, but persona matching depends on the configured backend TTS provider supporting the requested persona/voice mapping. The current CAMB adapter accepts numeric voice IDs and otherwise uses its configured default voice; production must configure an explicit mapping for the active Gemini persona (for example, `Kore`) or replace the adapter with a provider that accepts the persona directly. This is intentionally called out rather than claimed as verified because no live provider credentials or voice catalog were exercised in the sandbox.

The local WASM path is an injection boundary and requires the application to preload and provide a real model adapter. Without it, network failure correctly falls through to the non-verbal hum.
