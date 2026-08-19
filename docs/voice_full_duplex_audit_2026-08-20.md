# MindPal Voice v2: Full-Duplex Architecture Audit and Verification

**Date:** 20 August 2026
**Repository:** `M1rw/MindPal`
**Latest commit:** `dd824a8`
**Latest production deployment:** `dpl_AcrRKBX9kxEhWdvG1C8Wyv8FQC9n`

## Executive result

The audit found and fixed a real provider-startup defect that prevented the newest Voice deployment from reaching setup completion. The constrained Gemini Live WebSocket rejected both optional setup fields that had been enabled for Gemini 2.5: `proactivity` and `enableAffectiveDialog`. Gemini closed the socket with code **1007** before setup completed. The runtime trace was therefore a provider schema failure, not a VAD or audio-latency failure.

The production setup builder now sends only the accepted baseline configuration and keeps listening presence in the explicit, non-completing client-content cue path. The HTML asset version was also bumped from `rich-response-20260814` to `voice-duplex-20260820`, preventing browsers from reusing an older application bundle. The latest Vercel deployment is READY, recent Vercel grouped runtime errors returned none for the last two hours, and the repository’s full automated validation passes.

The implementation is substantially safer and more diagnosable, but a claim of literally zero bugs or complete parity with a proprietary realtime product would be inaccurate. The remaining externally dependent acceptance item is a fresh human-spoken long-story test against the newest cache-busted browser bundle. The connected browser extension timed out while the persisted Settings modal was being closed, so that specific human speech run could not be completed autonomously in this pass.

## 1. Old architecture versus Voice v2

| Area | Legacy architecture | Voice v2 architecture | Result |
|---|---|---|---|
| Session ownership | One large legacy runtime combined WebSocket lifecycle, capture, playback, transcripts, recovery, tools, and UI-facing state. | `voice_session_v2.js` is a facade over provider, capture, playback, orchestrator, backchannel, staging, tool, evidence, persistence, and recovery modules. | Smaller state surfaces and explicit ownership boundaries. |
| Provider transport | Legacy code directly built and sent WebSocket payloads from many runtime branches. | `gemini_live_adapter.js` owns wire encoding, normalization, setup completion, interruptions, resumption, and stale-socket protection. | Fewer transport races. |
| Audio capture | Legacy noise gates and provider turn events were interleaved in the same runtime. | `browser_audio_adapter.js` uses browser echo cancellation, noise suppression, auto gain control, AudioWorklet capture, and a capture adapter that emits 16 kHz PCM16 frames. | Capture remains low-latency while provider VAD remains the semantic turn authority. |
| Playback | Legacy playback and barge-in invalidation could be coupled to local assumptions. | `playback_manager.js` owns 24 kHz PCM scheduling, generation identities, cue/main audio classes, optimistic ducking, flush, and provider interruption invalidation. | Local speech can duck immediately; provider interruption performs authoritative clearing. |
| Transcripts | Earlier iterations mixed internal planning text with visible speech and allowed cumulative/delta duplication. | Transcript assemblers deduplicate keyed events, replace cumulative snapshots, append deltas once, filter internal reasoning, and pace captions from playback start. | Captions are more faithful to spoken audio. |
| Listening cues | Local English audio clips and a global “active backchannel” flag could misclassify normal answers or mismatch the Gemini voice. | Gemini-generated cue audio is used. Gemini 2.5 uses same-session `clientContent` with `turnComplete=false`; Gemini 3.1 uses its validated realtime-text path. | No local voice mismatch; cue classification is request-scoped. |
| Mute | Earlier mute behavior ended the provider input stream or changed connection state. | Mute is local: the media track is disabled, frames are suppressed, and silent keepalive frames preserve the session without sending `audioStreamEnd`. | Mute no longer ends or changes the call. |
| Recovery | Reconnect/reseed could lose state or mis-handle provider close events. | Session resumption, bounded reseed, durable transcript/context, identity generations, and recovery supervision are explicit. | Reconnects are safer, though all provider reconnections remain externally timed. |

## 2. Why previous full-duplex attempts felt weak

The primary issue was not that the browser could not capture simultaneous microphone and speaker audio. The browser capture path and playback path were already independent. The weak behavior came from **turn ownership**. Gemini’s VAD holds an active user turn while continuous speech is present. Provider proactive audio did not reliably insert an acknowledgement during uninterrupted speech, and the local scheduler previously deferred to that provider capability. This made the assistant wait for the user to yield instead of sounding attentive during natural internal pauses.

The second issue was cue transport semantics. A realtime text update sent while the user turn was active could be interpreted as ordinary user content or fail to produce a short acknowledgement. Voice v2 now uses the validated same-session client-content path for Gemini 2.5 with `turnComplete=false`, and the cue prompt explicitly marks the acknowledgement as non-completing control content. A pending-cue manager, cooldown, turn identity, and audio classification prevent the cue from replacing the main response.

The third issue was lifecycle interference. Mute, provider interruption, cue cancellation, playback classification, and transcript finalization had all been able to touch the same turn state. The V2 split makes local mute local-only, makes provider interruption authoritative for playback clearing, and keeps main-answer staging independent from cue output.

The final newly confirmed issue was **setup-schema drift**. The deployed constrained WebSocket rejected `proactivity`, then rejected `enableAffectiveDialog`, each with code 1007. No amount of VAD tuning could fix a session that never reached setup completion. The safe solution is to send an allowlisted baseline setup and treat optional provider capabilities as policy metadata until the exact transport/model combination is proven to accept them.

## 3. Vercel compliance audit

MindPal is not proxying the realtime PCM stream through a Vercel serverless function. The current topology is:

```text
Authenticated browser
    │ HTTPS token request
    ▼
Vercel-hosted FastAPI route
    │ provision short-lived Gemini ephemeral token
    ▼
Browser receives token + selected model + WebSocket URL
    │ direct WSS connection with access_token
    ▼
Gemini Live API
    │ direct PCM16 input / 24 kHz PCM output
    ▼
Browser playback + captions
```

This is the correct low-latency direction for Gemini’s documented client-to-server ephemeral-token flow: the backend authenticates the user and provisions a short-lived token; the browser connects directly to Gemini. Raw microphone frames do not travel through a Vercel request body, avoiding the 4.5 MB request/response payload limit.[4]

Vercel now documents WebSocket support for Vercel Functions, but an established connection is pinned only to the accepting Function for that connection, closes at the Function maximum duration, and cannot rely on in-memory state across reconnects. Vercel’s current Fluid Compute limits document 300 seconds on Hobby, up to 800 seconds on Pro/Enterprise, and a documented 1800-second extended option under specific conditions.[1] [2] [3] MindPal’s direct browser-to-Gemini transport avoids making a Vercel Function the long-lived audio proxy. The backend remains responsible for token provisioning, authenticated tools, telemetry, and durable state.

| Vercel concern | Current status | Required posture |
|---|---|---|
| Long-lived server-side audio WebSocket | Avoided; browser connects directly to Gemini. | Keep PCM off ordinary Vercel request bodies. |
| Function duration | Relevant to token and tool endpoints, not the direct Gemini socket. | Bound token/tool work and keep reconnect state resumable. |
| 4.5 MB payload limit | Not hit by live audio path. | Do not add audio batching or raw audio upload to token/diagnostic routes. |
| Reconnect to another instance | Possible for any server-side connection. | Keep state in returned credentials, resumption handles, and durable persistence rather than process memory. |
| Edge migration | Not required for the current token path. | Edge/WebRTC would be a future option only if direct Gemini WebSocket availability becomes unacceptable. |
| Browser caching | Previously unsafe because the HTML kept an old fixed query string. | Bump asset version whenever Voice wire/setup behavior changes. |

## 4. Interruptibility and VAD findings

The browser requests `echoCancellation`, `noiseSuppression`, and `autoGainControl`, captures through an AudioWorklet where available, and falls back to a ScriptProcessor only when required. Local RMS detection is used for **optimistic playback ducking**, not for declaring the semantic end of a user turn. The orchestrator begins ducking as soon as capture RMS crosses its start threshold and waits for the provider interruption event before authoritative playback clearing.

The deterministic harness measured the current orchestrator’s optimistic ducking transition within the first **20 ms capture frame** in the synthetic interruption stream. Release occurs after the low-level gap crosses the existing release threshold. This is the correct separation: local capture provides immediate UX response, while Gemini VAD owns semantic interruption and turn completion.

The remaining limitation is echo quality under device-specific browser conditions. Browser AEC is enabled, but this codebase does not control the operating system’s acoustic reference or every hardware driver. A production-grade diagnostic should continue recording local RMS, provider interruption timing, playback state, and device constraints without storing raw audio.

## 5. Backchannel findings

Backchannel eligibility requires an active transcript-backed turn, at least 8 seconds of speech, a 180–1200 ms pause window, adequate transcript confidence, no safety gate, no active main response, and a cooldown. This avoids firing on keyboard noise, short answers, crisis content, or after the user has already yielded.

The Gemini 2.5 path is now manual-cue-first at the wire level. Its provider policy keeps the capability metadata necessary for cue scheduling, but `getProviderSetupCapabilities()` returns an empty object for the constrained WebSocket because both optional provider setup fields were rejected in production. Explicit client-content cue messages remain non-completing. Gemini 3.1 retains its separate realtime-text transport policy.

The cue path is still subject to an important provider behavior boundary: a client can schedule a non-completing cue during a local pause window, but it cannot force Gemini to produce an acknowledgement at an exact point in continuous speech. The local scheduler therefore targets natural micro-pauses rather than trying to interrupt a currently active user phoneme.

## 6. Implemented changes in this pass

| Change | Verification |
|---|---|
| Removed `proactivity` and `enableAffectiveDialog` from the constrained Gemini setup payload. | Setup regression asserts both fields are absent; browser trace no longer needs to reach those rejected fields. |
| Bumped HTML asset query to `voice-duplex-20260820`. | Direct production HTTP fetch returned the new app bundle reference with `cache-control: no-cache`. |
| Added authoritative Vercel/Google transport audit record. | `docs/voice_external_audit_sources_2026-08-20.md` stores source URLs and findings. |
| Added deterministic WAV fixtures: `long_story.wav`, `sudden_interruption.wav`, and `background_noise.wav`. | Fixture generator validates mono PCM16, 16 kHz format and deterministic durations. |
| Added `tests/test_synthetic_voice_audio.mjs`. | Four synthetic tests pass, covering framing/mute, noise rejection, interruption ducking, and cue eligibility. |
| Added test coverage for model-specific setup and existing cue/main ownership. | Full JavaScript and Python suites pass. |
| Preserved direct Gemini WebSocket topology and ephemeral-token security. | Vercel compliance audit and no recent grouped runtime errors. |

## 7. Test and deployment log

| Test or check | Result |
|---|---:|
| JavaScript suite (`npm test`) | **146 passed** |
| Python suite (`pytest -q`) | **169 passed**, one existing deprecation warning |
| Production frontend build | **Passed** |
| Prebuilt frontend verification | **Passed: 75 inputs, 3 immutable outputs** |
| Synthetic WAV fixture suite | **4 passed** |
| Synthetic interruption ducking latency | **Within 20 ms capture frame** |
| Fresh production HTML asset query | **Verified: `voice-duplex-20260820`** |
| Vercel deployment dd824a8 | **READY** |
| Vercel grouped runtime errors, last two hours | **None found** |
| Fresh human long-story cue acceptance on newest browser bundle | **Not completed**: connected browser extension timed out on Settings-modal interaction |

## 8. Final assessment

The current architecture is compliant with the documented Vercel deployment model and is materially more robust than the archived monolithic runtime. The most serious current startup defect—provider rejection of optional setup fields—has been removed, cache invalidation has been corrected, and deterministic tests verify the key local duplex behaviors.

The honest remaining acceptance boundary is provider-side listening-cue behavior under a real human long story. Synthetic PCM verifies the client’s local path and policy; it cannot prove that Gemini will choose to speak a contextual acknowledgement at every micro-pause. A final acceptance run should use the fresh cache-busted production HTML, keep the Voice overlay open for at least 20–30 seconds, and inspect diagnostics for `voice.backchannel.requested`, cue audio classification, cue transcript, resumed user speech, and the subsequent main answer.

## References

[1]: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections "Vercel: Do Vercel Serverless Functions support WebSocket connections?"
[2]: https://vercel.com/docs/functions/websockets "Vercel WebSockets documentation"
[3]: https://vercel.com/docs/functions/limitations "Vercel Functions Limits"
[4]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens "Gemini Live API ephemeral tokens"
[5]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capabilities"
