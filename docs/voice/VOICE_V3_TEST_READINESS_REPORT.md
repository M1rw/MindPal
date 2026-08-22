# MindPal Voice V3 — Sprint 15 Test-Readiness Report

**Release candidate:** `feature/voice-v3-sprint15-test-ready`  
**Base release-candidate commit:** `48c1fed8dfec68b73497c3c61271dac8c6923073`
**Scope:** Local Voice Memory and internal Voice V3 test-readiness tooling  
**Author:** Manus AI  
**Date:** 2026-08-21

## Executive decision

> **NO-GO for broad production rollout; GO for controlled internal and staging validation.**

Sprint 15 is implemented and committed on an isolated feature branch. The candidate adds bounded browser-local memory, deterministic extraction, pre-connect Gemini setup-context injection, incognito and feature-flag gates, debug visibility, Gemini prebuilt voice-name setup, same-session native cue intents, an authenticated Gemini persona metadata endpoint, and the `/voice-v3-review` human listening page. Voice V2 remains the production path; no broad rollout was enabled. CAMB is not required by the default V3 composition root.

Automated validation passed. Broad rollout remains blocked because automated tests cannot establish real persona voice identity, browser microphone behavior, device-specific audio quality, authenticated staging reachability, or rollback evidence.

## Implemented scope

| Area | Result | Verification |
|---|---|---|
| Memory store | Complete | IndexedDB-backed record with bounded in-memory fallback, maximum 20 facts and 20 preferences, de-duplication, and oldest-entry eviction. |
| Deterministic extraction | Complete | Local regex extraction for explicit name, workplace, project, preference, and dislike statements; ambiguous language is rejected. No LLM or external extraction service is used. |
| Gemini setup injection | Complete | Memory context is loaded before socket open and is sent only under `setup.systemInstruction.parts[0].text` when non-empty. |
| Privacy gates | Complete | `VOICE_V3_MEMORY_ENABLED`, absent `memoryUserId`, and `incognito` prevent memory read, write, and injection. Memory events contain counts/metadata rather than transcript text. |
| Debug panel | Complete | Shows memory facts, preferences, injected context, extraction count, and Clear Memory action; label is Sprint 15. |
| React integration | Complete | `useVoiceV3` accepts and forwards `memoryUserId` and `incognito` with exact-optional-safe option spreads. |
| Gemini voice setup | Complete | Live setup sends the selected Gemini prebuilt voice name (`Kore` or `Charon`) under `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`; no provider voice ID is required. |
| Native cue path | Complete | Eligible cues become bounded `VOICE_CUE_REQUEST` realtime text intents; returned Gemini audio is generation-fenced and routed to the backchannel lane. |
| Human voice review | Complete | `/voice-v3-review` starts a real Gemini Live session for Kore or Charon, requests five native cues, observes playback scheduling, records pass/fail/unsure comments, and exports JSON. |
| Persona endpoint | Complete | Authenticated `GET /api/voice/v3/personas` returns the non-secret Gemini voice-name catalog with no credentials. |
| Documentation | Complete | Internal test plan, integration guide section, readiness report, and ignored review-artifact directory are present. |

## Automated validation evidence

The following commands were executed from the repository and completed successfully:

| Check | Result |
|---|---|
| `cd voice-v3 && npm run check` | Passed. |
| `cd voice-v3 && npm test -- --run` | Passed: 15 test files, 77 tests. |
| `cd voice-v3 && npm run build` | Passed: Vite production output generated, including the AudioWorklet bundle. |
| `pytest -q` | Passed: 186 tests, with one existing Starlette/httpx deprecation warning. |
| `python3 -m py_compile backend/api/voice_router.py` | Passed. |
| Repository safety scan | No detected API-key/private-key patterns; generated `.diagnostics/` files were excluded from the commit. |
| Final Git state | Feature branch tracks `origin/feature/voice-v3-sprint15-test-ready`; working tree is clean. |

The first staged commit attempt correctly failed the repository whitespace check because unrelated generated diagnostics and historical files contained whitespace warnings. The diagnostics were removed from the candidate, the source/test validation was rerun, and the original release candidate was created without force-pushing. This Gemini-only follow-up remains on the same protected feature branch and is not a production rollout.

## Safe production handoff state

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
VOICE_V3_MEMORY_ENABLED=false
```

V3 must remain disabled in production until the release owner closes the prerequisites below. Enabling the internal review route does not enable V3 for product users and does not replace the launch gate.

## Blocking prerequisites for broad rollout

| Prerequisite | Status | Required evidence |
|---|---|---|
| Gemini voice-name setup reachability | Outstanding staging evidence | Authenticated Live token, setup completion, and accepted `Kore`/`Charon` `voiceName` values from the deployed frontend origin. |
| Native cue response and audio-quality review | Outstanding | Reviewer listens to every native cue in the same Gemini session as the main response and records pass/fail/unsure in the review artifact. |
| CAMB/provider voice IDs | Not required | No CAMB IDs may be invented or added to the Gemini-only launch gate. |
| Manual test cases A–H | Outstanding | Completed `VOICE_V3_INTERNAL_TEST_PLAN.md` evidence, including memory deletion and account isolation. |
| Real staging soak | Outstanding | Ten-minute run covering interruptions, long monologue, reconnect, token expiry, network jitter, native cue fencing, and telemetry. |
| Rollback rehearsal | Outstanding | With flags disabled, a new session demonstrably returns to V2. |
| Production rollout | **NO-GO** | All blocking prerequisites must be closed and signed off. |

## Risk and privacy assessment

The memory layer is browser-local and keyed by the supplied user identifier; it is not a server-side profile system. The extractor accepts only high-confidence explicit patterns, bounds the injected context to five facts and five preferences with a 500-character cap, and does not call an external model. The implementation must still be manually checked for browser-storage deletion, account-switch isolation, private browsing behavior, and absence of memory content in telemetry.

The review page is an internal diagnostic surface. Its JSON export includes reviewer-entered comments, so access to the artifact must be controlled even though `artifacts/voice-persona-review/` is ignored by Git. The page performs no deployment, rollout, purchase, or production configuration action. Its cue requests use the active Gemini session and do not call CAMB or external TTS.

## Rollback and handoff

Keep `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0`, publish the runtime configuration, and verify that new sessions use Voice V2. Do not delete V2 files, force-push, or replace the main branch. Preserve only sanitized counters, state names, deployment IDs, and bounded error codes; never export microphone audio, PCM, transcripts, prompt content, memory text, provider tokens, or credentials.

## References

The operational procedures and manual acceptance cases are defined in [`VOICE_V3_INTERNAL_TEST_PLAN.md`](./VOICE_V3_INTERNAL_TEST_PLAN.md). Integration contracts and privacy boundaries are documented in [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md). The existing Gemini active-session text-update rationale remains documented in the integration guide’s reference section.
