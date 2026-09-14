# MindPal Voice V3 — Sprint 13 Release Plan

## Purpose and safety boundary

Sprint 13 is the production launch gate for Voice V3. Voice V2 remains the fallback path until the V3 gate is explicitly enabled for a cohort. The launch process is designed so a flag or validation failure disables V3 verbal features without removing V2 voice, session history, microphone permissions, or backend availability.

## Feature flags

| Flag | Default | Effect when disabled |
|---|---:|---|
| `VOICE_V3_ENABLED` | `false` | Do not instantiate or start V3; keep V2 active. |
| `VOICE_V3_VERBAL_CUES_ENABLED` | `true` | Use the non-verbal hum/no verbal cue path. |
| `VOICE_V3_PROSODY_CONTEXT_ENABLED` | `true` | Do not inject prosody context notes into Gemini. |
| `VOICE_V3_MEMORY_ENABLED` | `true` | Do not use the V3 memory capability. |
| `VOICE_V3_CLARIFICATION_ENABLED` | `true` | Do not use the V3 clarification capability. |

Environment values are evaluated first, then user overrides, then session overrides. `VOICE_V3_ROLLOUT_PERCENT` deterministically assigns users or sessions to a cohort. The client supports Vite `VITE_` variables, runtime `__MINDPAL_VOICE_V3_FLAGS__`, and explicit context overrides. The backend has matching typed settings and deterministic assignment.

## Production launch gate

At startup the backend validates the enabled persona list against `PersonaVoiceCatalog`. Every enabled persona must have an explicit provider voice ID. Missing IDs are not replaced with a provider default. The gate records endpoint and cache-warm probe results when supplied by deployment checks. A failed mapping or probe marks verbal cues unavailable and logs the reason; it does not crash the server.

Required settings before enabling a production cohort are:

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
CAMB_KORE_VOICE_ID=<real configured CAMB voice ID>
CAMB_CHARON_VOICE_ID=<real configured CAMB voice ID>
```

The deployment process must run `python scripts/warm_voice_cue_cache.py` with authenticated credentials, then run `python scripts/verify_voice_personas.py` and complete human voice-identity review. The warm step uses neutral emotion for `mhm`, `yeah`, `aha`, `right`, and `okay` and requires a cache hit on the second request for every enabled persona.

## Canary stages

| Stage | Entry criteria | Exit criteria | Metrics to monitor | Rollback trigger | Rollback procedure |
|---|---|---|---|---|---|
| Internal staff only | Launch gate passes; voice IDs set; cache warm succeeds; all verification samples reviewed; soak test passes. | At least 20 staff sessions across supported browsers/devices with no P0/P1 voice failures and no mismatched verbal cues. | Session failure, TTS success/timeout/fallback, mapping-missing, cache hit, stale audio, underrun, recovery, duplicate greeting/caption. | Any privacy violation, mismatched verbal voice, repeated greeting, stale audio, or session failure above 5%. | Set `VOICE_V3_ENABLED=false`, publish config, verify V2 starts in a fresh session, preserve history. |
| 5% canary | Staff exit criteria met; V2 rollback smoke test green; alerts and dashboard live. | At least 100 sessions or 24 hours, session failure under 2%, TTS timeout under 5%, non-verbal fallback under 3%, zero mapping-missing for enabled personas. | Same as staff plus cohort comparison against V2. | Session failure >= 2% for 15 minutes, timeout >= 5% for 10 minutes, any P0/P1. | Set rollout to 0 or disable V3; drain active V3 sessions naturally where safe; use V2 for new sessions. |
| 25% | 5% exit criteria met; no open P1; support and on-call coverage confirmed. | At least 500 sessions or 48 hours, no regression versus V2 on session failure or recovery activation, no stale playback. | Stage and V2 baseline deltas, queue depth, underruns, caption drift, fallback rate. | Any threshold breach for two consecutive windows or persona mismatch. | Reduce rollout to previous safe stage, then disable V3 if breach persists; retain diagnostics counters only. |
| 50% | 25% exit criteria met; cache warm and endpoint health stable through a deployment cycle. | At least 1,000 sessions or 72 hours, all P0/P1 zero, all alerts within thresholds. | All dashboard panels; inspect device/browser segmentation. | Any P0/P1, privacy breach, or sustained session-failure increase above V2 baseline by 1 percentage point. | Return to 25%, notify on-call, invalidate only affected V3 sessions if needed, keep V2 enabled. |
| 100% | 50% exit criteria met; signed release report; rollback rehearsal completed. | Continuous monitoring for 7 days with no unresolved launch-gate failures and all prerequisites recorded. | All dashboard panels and V2 comparison until the post-launch review. | Any safety/privacy issue or two consecutive high-severity alert windows. | Set `VOICE_V3_ENABLED=false` immediately, set rollout 0, restore V2 entry path, verify history/auth/mic smoke tests, and preserve evidence. |

## Dashboard specification and alerts

| Panel | Calculation | Recommended alert threshold |
|---|---|---|
| TTS request success rate | `tts.request.success / tts.request.started` | Warning below 98%; critical below 95% for 10 minutes. |
| TTS timeout rate | `tts.request.timeout / tts.request.started` | Warning above 3%; critical above 5% for 10 minutes. |
| TTS fallback rate | `tts.fallback.nonverbal / tts.request.started` | Warning above 2%; critical above 3% excluding intentional missing-map tests. |
| Persona mapping missing | Count of `tts.persona_mapping_missing` | Any production event is critical and blocks rollout until resolved. |
| Cache hit rate | `tts.cache.hit / (tts.cache.hit + tts.cache.miss)` | Warning below 80% after warm-up; investigate cold-start or key fragmentation. |
| Cue prefetch latency | P50/P95 `predictivePrefetchLatencyMs` | Warning P95 above 250 ms; critical above 600 ms. |
| Backchannel cue played | Count of accepted `BACKCHANNEL_CUE_REQUESTED` | Monitor by cohort; no absolute alert without traffic normalization. |
| Backchannel cue rejected | Suppressed/stale cue count divided by cue attempts | Warning above 20%; investigate only if user speech is not long/paused. |
| Playback underrun | `playback.underrun` per 100 sessions | Warning above 1 per 100 sessions; critical above 5 per 100. |
| Stale artifact rejection | Stale chunk/caption rejection count | Any stale audio played is critical; rejected stale artifacts are expected but must trend downward. |
| Recovery/fallback activation | Recovery transitions plus local/non-verbal fallback count | Warning above 5% of sessions; critical above 10%. |
| Session failure rate | Failed sessions divided by started sessions | Warning above 1%; critical above 2% for 15 minutes. |

Dashboard dimensions must be limited to environment, release, browser/device class, provider source, persona, and sanitized error code. Do not include audio, PCM, transcripts, prompts, or context-note text.

## Soak test plan

Run `npm test -- --run src/integration/voice-v3-soak.test.ts` for the deterministic ten-minute virtual-time soak. It simulates 600,000 ms with 20 ms ticks and covers a long monologue, rapid interruptions, network jitter, TTS timeout, missing persona mapping, backend restart, token expiry/refresh, GoAway recovery, and fallback activation. It asserts the cue buffer never exceeds three items, queue depth never exceeds 1,600 ms, stale audio playback is zero, captions are not duplicated, greetings do not replay, and persona cues are never mismatched.

The deterministic test is a launch-gate regression test, not a substitute for a real staging run. Before 100%, conduct a real ten-minute session per supported browser/device class with microphone permission, reconnect, token refresh, GoAway, TTS restart, and rollback smoke checks. Record only counters and sanitized outcomes.

## Exact rollback procedure

1. Set `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0` in the environment configuration.
2. Publish the configuration and invalidate the V3 feature-flag cache if the deployment platform caches runtime configuration.
3. Confirm new sessions enter the existing V2 path and do not request V3 TTS or V3 prosody context.
4. Allow safe active-session completion where possible; terminate only sessions that are failing or emitting stale audio.
5. Verify existing session history remains readable and that no V3-only dependency is required by V2.
6. Verify Firebase authentication, microphone permission prompts, captions, mute behavior, and V2 voice startup in a fresh browser session.
7. Preserve sanitized telemetry, deployment IDs, error codes, and the last known-good cohort configuration for investigation. Do not export audio or transcripts.
8. Resolve the blocking issue, rerun the launch gate, cache warm, persona review, and soak test, then restart at the last safe canary stage rather than jumping directly to 100%.

## Go/no-go checklist

| Check | Required for go |
|---|---:|
| All five feature flags configured and reviewed | Yes |
| V3 disabled by default in production configuration | Yes |
| Explicit voice ID for every enabled persona | Yes |
| No silent provider-default voice path | Yes |
| Authenticated endpoint reachability verified | Yes |
| Neutral common-cue cache warm verified for every persona | Yes |
| Human review confirms Gemini/TTS persona identity | Yes |
| Ten-minute deterministic and real staging soak complete | Yes |
| Dashboard and alerts active | Yes |
| V2 rollback smoke test complete | Yes |
| Privacy review confirms no audio/PCM/transcript telemetry | Yes |
