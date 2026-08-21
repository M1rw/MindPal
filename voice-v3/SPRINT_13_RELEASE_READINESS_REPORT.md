# MindPal Voice V3 — Sprint 13 Release Readiness Report

## Executive decision

**Decision: NO-GO for broad production rollout; GO for controlled internal/staging validation.**

The code, launch gate, deterministic soak harness, cache-warm tooling, canary plan, and rollback procedure are implemented and validated. Broad rollout must wait for real production CAMB voice IDs, authenticated cache warming, human voice-identity review, a real staging soak, and live dashboard/alert confirmation.

## Completed sprint scope

| Sprint | Status | Outcome |
|---|---|---|
| 0 | Complete | LayerLink core and typed message bus. |
| 1 | Complete | AudioWorklet capture, 48/44.1 kHz to 16 kHz conversion, PCM16 transfer, mute keepalive. |
| 2 | Complete | WebSocket transport, bounded queues, framing, setup, keepalive, and resumption. |
| 3 | Complete | Stateless Gemini provider adapter and multipart/thought filtering. |
| 4 | Complete | 24 kHz playback, jitter scheduling, lane routing, ducking, and generation fencing. |
| 5 | Complete | Backchannel conductor, pause eligibility, cooldowns, and LayerLink-only cue requests. |
| 6 | Complete | Orchestrator state machine, stale-event fencing, greeting protection, and flush behavior. |
| 7 | Complete | User/assistant assemblers, cumulative reconciliation, playback-gated captions, RTL rendering. |
| 8 | Complete | Composition root, mock server, dashboard, error boundary, and end-to-end integration. |
| 9 | Complete | Real token provider, static cue integration, React hook, privacy-safe telemetry, and guide. |
| 10 | Complete | Realtime TTS provider, predictive cue prefetch, backend PCM16 endpoint, and fallback model boundary. |
| 11 | Complete | Local prosody analyzer, controlled context notes, active-session `realtimeInput.text`, and prosody-aware playback. |
| 12 | Complete | Persona voice catalog, explicit voice IDs, hardened TTS fallback, cache verification utility, and tests. |
| 13 | Complete | Feature flags, launch gate, cache-warm script, canary/rollback plan, dashboard specification, and soak harness. |

## Required production configuration

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
VOICE_V3_VERBAL_CUES_ENABLED=true
VOICE_V3_PROSODY_CONTEXT_ENABLED=true
VOICE_V3_MEMORY_ENABLED=true
VOICE_V3_CLARIFICATION_ENABLED=true
CAMB_KORE_VOICE_ID=<real configured CAMB voice ID>
CAMB_CHARON_VOICE_ID=<real configured CAMB voice ID>
```

The client may additionally receive `VITE_VOICE_V3_*` values or a runtime `__MINDPAL_VOICE_V3_FLAGS__` object. User and session overrides must be managed by the product rollout system, not hard-coded in the browser bundle.

## Outstanding prerequisites

The production CAMB voice IDs are not fabricated and are not present in the sandbox. Each enabled persona must receive a verified provider voice ID. The authenticated endpoint must be reachable from the deployed frontend, and `scripts/warm_voice_cue_cache.py` must warm all five neutral cues for every enabled persona and confirm second-request cache hits. `scripts/verify_voice_personas.py` must save samples for human review, and reviewers must confirm that each sample’s identity matches the active Gemini persona.

A real staging soak must cover ten minutes, interruptions, long monologues, network jitter, TTS timeout, missing mapping, backend restart, token expiry, GoAway recovery, and fallback activation. The telemetry dashboard and alerts must be live before the first external canary.

## Telemetry thresholds

| Signal | Warning | Critical/blocking |
|---|---:|---:|
| TTS success rate | Below 98% | Below 95% for 10 minutes |
| TTS timeout rate | Above 3% | Above 5% for 10 minutes |
| Non-verbal fallback rate | Above 2% | Above 3%, excluding intentional tests |
| Persona mapping missing | Any event | Blocks rollout |
| Cache hit rate after warm | Below 80% | Investigate before expansion |
| Prefetch latency P95 | Above 250 ms | Above 600 ms |
| Playback underruns | Above 1/100 sessions | Above 5/100 sessions |
| Recovery/fallback activation | Above 5% | Above 10% |
| Session failure rate | Above 1% | Above 2% for 15 minutes |
| Stale audio played | Any | Immediate rollback |
| Privacy violation | Any | Immediate rollback |

## Feature flag state at handoff

The safe handoff state is **all V3 disabled in production**: `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0`. Dependent feature flags are forced off by the client when the top-level flag is off. Mock mode remains available for deterministic development and tests. Enabling V3 is a release action that must follow the canary stages, not an implicit side effect of building the package.

## Rollback

Set `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0`, publish the runtime configuration, and invalidate any feature-flag cache. Confirm new sessions enter V2, preserve session history, verify authentication and microphone permissions, and confirm V2 mute/captions/voice startup. Preserve sanitized metrics and deployment identifiers, but never export audio, PCM, transcripts, or context-note text. Restart at the last safe canary stage only after the launch gate, cache warm, human review, and soak checks pass again.

## Go/no-go checklist

| Requirement | Status |
|---|---|
| Feature flag layer implemented and tested | Ready |
| V2 fallback remains available when V3 is disabled | Ready by design; staging smoke required |
| Production launch gate implemented and non-fatal | Ready |
| Explicit Kore/Charon provider voice IDs | Outstanding |
| Authenticated endpoint reachability | Outstanding staging evidence |
| Neutral cache warm for all enabled personas | Outstanding deployment run |
| Human persona voice review | Outstanding |
| Deterministic ten-minute soak | Passed |
| Real staging ten-minute soak | Outstanding |
| Dashboard and alert installation | Outstanding |
| Rollback rehearsal | Outstanding |
| Broad production rollout | **No-go until all outstanding items are closed** |

## Validation evidence

The authoritative final validation passed:

```text
npm run check  — passed
npm test       — 14 test files, 70 tests passed
npm run build  — passed; Vite production output generated
pytest -q     — 186 passed, 1 warning
py_compile    — passed for modified backend and deployment scripts
```

The deterministic ten-minute virtual-time soak passed. No authenticated provider call or human voice-identity review was performed in the sandbox, so those remain required before broad production rollout.
