# MindPal Voice V3 — Sprint 9 Completion Report

## Status

Sprint 9 implementation is complete in the isolated `voice-v3/` workspace. Voice V2 production remains unchanged by this pass. The V3 engine now has the production integration boundaries needed for authenticated token acquisition, static cue loading, React lifecycle ownership, privacy-safe delivery diagnostics, and staging integration.

## Delivered

`RealTokenProvider` calls `GET /api/voice/token` with Firebase Authorization and App Check headers when supplied, caches tokens with a 30-second safety window, handles ISO/epoch expiry formats, honors `Retry-After`, retries transient failures, stops retrying HTTP 429, and exposes fallback-grant response metadata.

`StaticAssetCueProvider` exposes `initialize()`/`preload()`, fetches `/assets/cues/mhm.wav`, `/assets/cues/yeah.wav`, and `/assets/cues/aha.wav` once, decodes mono 24 kHz buffers, extracts cached PCM16 little-endian data, returns backchannel-lane `AudioChunk` values synchronously after initialization, and falls back to `SyntheticCueProvider` if the asset set cannot be loaded. Playback accepts the cached decoded buffer to avoid a second decode on each cue.

`useVoiceV3` creates `VoiceV3App` only inside a React effect, subscribes to orchestrator/caption/transport/playback/capture LayerLink events, batches updates through a microtask and React transition, exposes start/stop/mute/unmute controls, maps FAILED/RECOVERING/microphone errors to the requested UX strings, and disposes app, subscriptions, and telemetry on unmount.

`TelemetrySink` records only numeric counters, sanitized error codes, state-transition counts, queue-depth aggregates, caption-drift aggregates, stale-event counts, and approved delivery counters. Its POST body contains exactly the backend diagnostic field names and never serializes audio, PCM, base64 audio, transcripts, captions, prompts, or provider content. Interval sends use normal requests; final close sends `keepalive: true` and a session end reason. Diagnostic failures are isolated from voice-session execution.

`VoiceV3App` now exports `PRODUCTION_MODE`, accepts production auth/base URL options and injectable providers, selects `RealTokenProvider` in real mode, selects `StaticAssetCueProvider` in production mode, preloads cues before capture starts, and preserves mock mode for deterministic local testing.

`INTEGRATION_GUIDE.md` documents V2 React mounting, Firebase token callbacks, public cue placement, asset constraints, production rollout checks, recovery strings, and telemetry privacy requirements.

## Validation evidence

The required command completed successfully:

```text
npm run check  — passed
npm test       — 10 test files, 48 tests passed
npm run build  — passed; Vite production output generated in voice-v3/dist/
```

Sprint 9 tests cover authenticated token success and retry behavior, HTTP 429 handling, expiry caching, one-time cue decode and PCM16 conversion, synthetic fallback, React mount/unmount and mute controls, telemetry batching, auth headers, close flush, and payload privacy.

## Deployment prerequisite

No real prerecorded cue files existed in the repository during this sprint. The code path and public URL contract are ready, and missing assets safely use the synthetic fallback, but production rollout should upload and verify the three real files at the documented public paths before enabling V3 for end users.
