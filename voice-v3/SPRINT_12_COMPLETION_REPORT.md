# MindPal Voice V3 — Sprint 12 Completion Report

## Status

Sprint 12, **Persona Voice Catalog & Live TTS Validation**, is implemented. The goal was to prevent mismatched verbal cues by requiring an explicit backend voice ID for each enabled Gemini persona and by making every failure resolve to a controlled non-verbal hum rather than an unknown default voice.

## PersonaVoiceCatalog

`backend/services/persona_voice_catalog.py` adds the backend configuration layer. The current catalog includes the enabled `Kore` and `Charon` personas with CAMB provider metadata, gender/style labels, and environment-backed voice IDs. The IDs are declared in typed settings as `CAMB_KORE_VOICE_ID` and `CAMB_CHARON_VOICE_ID`.

There is no silent default voice. An unset ID is represented as `REQUIRED` in non-secret public configuration and fails resolution. Unknown or unconfigured personas produce a controlled `fallback: "non_verbal_hum"` response and log `tts.persona_mapping_missing`. Provider credentials never cross the client boundary.

## Hardened realtime TTS endpoint

`POST /api/voice/v3/tts` now resolves the persona before invoking `TTSService`, passes the resolved provider voice ID, and uses a cache key containing persona, emotion, cue text, and sample rate. The common cue set is `mhm`, `yeah`, `aha`, `right`, and `okay`. Responses may include `cached`, `voiceId`, `persona`, and `fallback` metadata.

The backend preserves the resolved persona when a provider does not support emotional styles. Non-neutral unsupported styles are ignored and logged as `tts.emotion_unsupported`; the request still generates in the correct persona voice. Audio is normalized to mono 24 kHz PCM16. Provider-unavailable, malformed-audio, service-error, and missing-mapping cases return the controlled empty-audio fallback response rather than a mismatched verbal cue.

## Client safety and telemetry

`RealtimeTTSProvider` now publishes sanitized events for request start/success/failure/timeout, cache hit/miss, persona mapping failure, unsupported emotion, non-verbal fallback, and duration. The client recognizes the backend fallback response, retries an HTTP 400/422 emotional-style rejection once with `neutral`, and sends malformed audio directly to the non-verbal hum path. No event payload contains audio bytes, PCM, transcript text, or provider credentials.

## Pre-warm and persona verification

`backend` retains a bounded common-cue cache keyed by persona, emotion, text, and sample rate. `scripts/verify_voice_personas.py` is the controlled first-deployment/pre-warm and human-review utility. It requests `mhm/neutral`, `okay/calm`, `yeah/excited`, and `aha/attentive` for each selected persona, saves valid responses as reviewable mono 24 kHz PCM16 WAV files, and writes a manifest without storing authentication tokens.

A successful HTTP response is not treated as proof of persona identity. The generated samples must be listened to and compared with the active Gemini persona before V3 is enabled for users.

## Tests and validation

Sprint 12 backend tests cover explicit voice-ID resolution, missing-map fallback, unsupported emotion compatibility, cache isolation by persona/emotion, common-cue cache hits, and normalized audio output. Frontend tests cover persona-mapping fallback, malformed-audio fallback, unsupported-emotion retry, event emission, network cache behavior, and predictive conductor compatibility.

The final validation passed:

```text
npm run check  — passed
npm test       — 12 test files, 66 tests passed
npm run build  — passed; Vite production output generated
pytest -q     — 182 passed, 1 warning
py_compile    — passed for modified backend and verification files
```

The verification utility’s `--help` path and the production `voice-v3/dist/index.html` artifact were also checked.

## Scope and rollout caveat

Sprint 12 intentionally includes backend changes because the catalog and TTS route are server responsibilities. The current working tree also contains prior Sprint 10/Sprint 11 artifacts and untracked diagnostic/documentation files. The real CAMB voice IDs are not fabricated in this workspace; production must set `CAMB_KORE_VOICE_ID` and `CAMB_CHARON_VOICE_ID` and complete the WAV human-review workflow before rollout.
