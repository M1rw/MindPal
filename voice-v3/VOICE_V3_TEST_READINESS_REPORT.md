# MindPal Voice V3 — Sprint 15 Test Readiness Report

## Executive decision

**Decision: NO-GO for broad production rollout; GO for internal and controlled staging validation.**

The Sprint 15 implementation adds bounded browser-local memory, deterministic extraction, setup-context injection, incognito gating, debug visibility, a persona review page, and the authenticated persona metadata endpoint. The release candidate is isolated under `voice-v3/`; Voice V2 remains the live production path. Broad rollout is blocked until human listening review, authenticated staging evidence, and the remaining operational prerequisites are completed.

## Completed scope

| Area | Status | Evidence / outcome |
|---|---|---|
| Sprints 0–14 | Complete | Existing engine layers, orchestration, captions, TTS, prosody, persona catalog, flags, cache warm, launch gate, and soak harness remain in place. |
| Local memory store | Complete | IndexedDB-backed record with in-memory fallback, 20-fact and 20-preference bounds, de-duplication, and oldest-entry eviction. |
| Deterministic extractor | Complete | Local regex extraction for explicit name/work/project/preference/dislike statements; ambiguous statements are rejected. No LLM or external extraction call. |
| Setup injection | Complete | Context is fetched before socket open and added only to Gemini `systemInstruction.parts` when non-empty. |
| Flag and privacy gates | Complete | `VOICE_V3_MEMORY_ENABLED`, missing user ID, and `incognito` prevent memory read/write/injection. |
| Debug observability | Complete | Memory counts, bounded lists, last injected context, extraction count, and clear-memory action are visible in the V3 debug panel; label updated to Sprint 15. |
| Internal voice review | Complete | `/voice-v3-review` fetches public catalog metadata, requests five common cues per enabled persona, plays PCM16 samples, records review decisions, and exports JSON. |
| Persona catalog API | Complete | Authenticated `GET /api/voice/v3/personas` returns `public_config()` and uses `REQUIRED` for missing mappings. |
| Documentation and artifact safety | Complete | Internal test plan, integration guide, this report, and ignored review-artifact path added. |

## Validation status

The focused Sprint 15 memory and transport tests passed after correcting the test to match the store’s newest-five context policy. The final automated release-candidate validation was then executed successfully. Manual browser, listening, staging, and rollback evidence remains intentionally pending.

| Check | Required command | Current status |
|---|---|---|
| Strict TypeScript | `cd voice-v3 && npm run check` | Passed after app, hook, DebugPanel, and review-page integration. |
| Voice V3 tests | `cd voice-v3 && npm test -- --run` | Passed: 15 files, 75 tests. |
| Vite build | `cd voice-v3 && npm run build` | Passed: Vite production output generated. |
| Backend tests | `pytest -q` | Passed: 186 tests, 1 existing deprecation warning. |
| Backend syntax | `python3 -m py_compile backend/api/voice_router.py` | Passed. |
| Manual review | `VOICE_V3_INTERNAL_TEST_PLAN.md`, cases A–H | Pending human/staging execution. |

## Feature-flag handoff state

The safe production handoff remains:

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
VOICE_V3_MEMORY_ENABLED=false
```

The memory flag may be enabled only for an explicitly controlled internal or staging session after the product has established a clear consent and deletion experience. Dependent V3 flags must not cause an implicit production rollout. No production V2 entrypoint is changed by this release candidate.

## Blocking prerequisites

| Prerequisite | Status | Why it blocks broad rollout |
|---|---|---|
| Real explicit Kore and Charon provider voice IDs | Outstanding unless configured in deployment | The implementation refuses to guess a provider voice. |
| Authenticated persona catalog and TTS reachability | Outstanding staging evidence | The review route must work with the deployed auth/session path. |
| Human voice-identity review | Outstanding | HTTP success cannot prove that a cue matches the active Gemini persona. |
| Manual cases A–H | Outstanding | Automated tests cannot cover browser permissions, listening quality, long monologues, or rollback behavior. |
| Staging soak and telemetry review | Outstanding | Requires real network, token expiry, reconnect, TTS fallback, and device/browser observations. |
| Rollback rehearsal | Outstanding | Must verify new sessions return to V2 with V3 flags disabled. |

## Risk and privacy assessment

Memory stays in the browser storage namespace selected by `memoryUserId`; it is not a server-side profile store. The extractor accepts only explicit deterministic patterns and publishes count/size metadata rather than transcript content. The setup context is bounded before injection. Incognito and disabled-flag sessions bypass the layer. The team must still verify browser-storage deletion, account-switch isolation, private-window behavior, and absence of memory content in telemetry during manual testing.

The `/voice-v3-review` page is an internal diagnostic surface, not a launch control. Its exported JSON contains catalog/sample metadata, statuses, comments, and a decision, but it must be reviewed before sharing because comments can still contain sensitive tester-entered text. The ignored path prevents accidental Git commits; it does not replace access control.

## Go/no-go checklist

| Requirement | Decision |
|---|---|
| Sprint 15 implementation present and isolated from V2 | Ready |
| Strict TypeScript check | Passed |
| Focused memory and transport regression tests | Passed |
| Full V3 test suite | Passed: 15 files, 75 tests |
| Production build | Passed |
| Backend tests and syntax check | Passed: 186 tests; compile passed |
| Memory disabled by default in production | Ready by configuration |
| Incognito path does not persist or inject memory | Automated coverage ready; manual verification pending |
| Persona voice IDs verified by human listening | Outstanding |
| Authenticated staging and ten-minute soak | Outstanding |
| Rollback rehearsal | Outstanding |
| Broad production rollout | **NO-GO** |

## Rollback and handoff

To roll back, keep `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0`, publish the runtime configuration, and confirm that new sessions use V2. Do not delete V2 files or force-push over the main branch. Preserve only sanitized deployment and counter evidence; never export audio, PCM, transcripts, prompts, memory text, or provider credentials.

The intended delivery is the feature branch `feature/voice-v3-sprint15-test-ready`. Commit and push only after the complete validation commands pass and a repository diff confirms that no secrets, generated review artifacts, or unrelated production changes are included.
