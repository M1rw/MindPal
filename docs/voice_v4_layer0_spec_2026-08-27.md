# Voice V4 Layer 0 — Contract and Release-Control Specification

**Status:** Approved implementation scope for Layer 0 only. This specification authorizes no provider connection, microphone capture, playback, token provisioning, prompt adaptation, or production enablement.

## Purpose

Layer 0 creates the stable contract around Voice V4 before any media or provider runtime exists. It makes the intended transport, audio formats, lifecycle vocabulary, diagnostic allow-list, release gates, and security prohibitions executable and testable.

## Contract

The baseline contract is audio-only full duplex, with mono PCM16 little-endian input at 16 kHz and mono PCM16 little-endian output at 24 kHz. The initial provider target is `gemini-3.1-flash-live-preview`, subject to a later capability and availability check. The baseline uses one fixed instruction, one voice, automatic VAD, no tools, no memory, no session resumption, no reconnect, and no dynamic affect.

The stable feature key is `voice.live_v4`. Its default lifecycle is `disabled` and its default availability is false. The existing feature-management system remains the only release-policy authority. Layer 0 may read an evaluated feature state; it must not create a second competing rollout system.

## Release decision rules

A future runtime may proceed only when all required conditions are true:

| Condition | Production | Protected preview |
| --- | --- | --- |
| `voice.live_v4` evaluated enabled | Required | Required |
| Explicit approval recorded | Required | Required |
| Environment is non-production | No | Required |
| Gates A–F passed | Required | Required before claiming functional |
| V3 runtime restored | Forbidden | Forbidden |
| Permanent provider key in browser | Forbidden | Forbidden |

Layer 0 must fail closed. If the feature evaluation is missing, stale, unknown, disabled, or contradictory, the release decision is denied.

## Safe diagnostic contract

Diagnostics may contain only a random session identifier, approved event category, approved lifecycle state, generation and playback epoch, AudioContext state, bounded numeric counters, queue duration, active-source count, sanitized error code, and sanitized provider message category. They must not contain access tokens, API keys, authorization headers, provider URLs, raw PCM, microphone content, transcript text, prompt text, user identity, or raw provider error bodies.

The diagnostic module must reject or discard unknown fields rather than pass them through. Numeric counters are bounded to prevent accidental unbounded payloads. Strings are selected from enumerations or constrained patterns.

## Test fixtures

Fixtures contain message shapes and numeric metadata only. They must never contain audio bytes, transcripts, provider credentials, user identifiers, or downloadable WAV/PCM content. A multipart server-message fixture may represent an audio part using a symbolic placeholder that is never sent to a provider or decoded as real media.

## Layer 0 exit criteria

Layer 0 is complete only when its pure contract tests pass, forbidden-data tests pass, the `voice.live_v4` feature remains disabled by default, the active frontend build contains no Voice V4 runtime, and all repository frontend/security audits remain green.

## Explicit exclusions

The following are outside this batch and require a separate approval: Layer 1 token endpoint, Layer 2 parser/state machine, Layer 3 microphone capture, Layer 4 playback, Layer 5 WebSocket session orchestration, Layer 6 Voice UI activation, Layer 7 protected preview, and Layer 8 dynamic feelings/persona behavior.
