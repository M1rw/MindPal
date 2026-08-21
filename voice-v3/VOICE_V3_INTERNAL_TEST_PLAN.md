# MindPal Voice V3 — Internal Test Plan

**Release candidate:** Sprint 15 Local Voice Memory and Voice V3 test-readiness tooling  
**Branch:** `feature/voice-v3-sprint15-test-ready`  
**Production boundary:** Voice V2 remains live while this plan is executed.

## Purpose and safety boundary

This plan validates the isolated `voice-v3/` engine, its local memory behavior, and the internal human voice review surface. It is not authorization for a broad rollout. Testers must not paste provider secrets into browser fields, commit generated audio or review exports, or change the production V2 entrypoint. Use a dedicated test account when persistence or account-switch behavior is being checked.

A case passes only when the expected behavior is observed and sanitized evidence is recorded. Any privacy leak, stale audio playback, invented persona voice ID, accidental V2 modification, or inability to roll back is immediately blocking.

## Preconditions and commands

Use an authenticated local or staging session, a working microphone, and a browser that supports IndexedDB and Web Audio. Keep the safe production values `VOICE_V3_ENABLED=false` and `VOICE_V3_ROLLOUT_PERCENT=0`. For memory tests, use a unique `memoryUserId`; for incognito tests, use a separate session or clear the record before starting. For persona review, configure only real backend voice IDs and keep all credentials server-side.

Run the automated gate before manual testing:

```bash
cd voice-v3
npm run check
npm test -- --run
npm run build
cd ..
pytest -q
python3 -m py_compile backend/api/voice_router.py
```

## Manual acceptance cases

| ID | Scenario and procedure | Expected acceptance result | Evidence |
|---|---|---|---|
| A | **Flag matrix and V2 safety.** Run with `VOICE_V3_ENABLED=false`; then run the isolated harness with V3 enabled. Exercise start, stop, mute, captions, and reconnect. | With the top-level flag off, the V3 hook does not create a V3 app and V2 remains responsible for voice. No V2 production file or route is modified. | Flag values, route/build identifier, and sanitized console excerpt. |
| B | **Explicit local extraction.** Say: “My name is Marwan. I work at MindPal. I am building Voice V3. I prefer concise answers. I don’t like static audio assets.” End the turn. Then say a hedged statement such as “Maybe I like dark mode, I think.” | Explicit statements become normalized facts/preferences; extraction count increments; hedged language is ignored. Memory events contain bounded metadata, not raw transcript text. | Debug-panel screenshot and sanitized LayerLink event list. |
| C | **Persistence, limits, and deletion.** Add more than 20 facts and more than 20 preferences, stop, restart with the same `memoryUserId`, then press **Clear memory**. | The newest 20 entries remain per category; the record survives restart in IndexedDB; setup context contains at most five facts and five preferences and no more than 500 characters; Clear memory removes the record. | Redacted before/after snapshots and browser storage observation. |
| D | **Incognito and disabled memory.** Run once with `incognito=true`, then with `VOICE_V3_MEMORY_ENABLED=false`; speak explicit memory statements and reconnect. | Neither mode reads, injects, stores, or publishes user memory. The rest of the voice session remains functional. | Configuration and sanitized network/event evidence. |
| E | **Setup injection and isolation.** Preload a record and inspect the outbound setup payload in a controlled mock/staging environment. Repeat with an empty record, disabled memory, and incognito. | Non-empty context appears only at `setup.systemInstruction.parts[0].text`. Empty, disabled, and incognito sessions send no `systemInstruction`; audio and transcripts are never used to build it. | Redacted setup JSON and transport test result. |
| F | **Human persona and cue review.** Open `/voice-v3-review`, verify catalog metadata, and fetch `mhm`, `yeah`, `aha`, `right`, and `okay` for Kore and Charon. Play every available sample and mark pass/fail/unsure with comments. | Missing mappings display `REQUIRED` and never invent an ID. Configured samples report duration/cache/fallback metadata and play as mono 24 kHz PCM16. Export contains review data but no credentials. | Review JSON under the ignored artifact path and reviewer sign-off stored outside the repository. |
| G | **Full-duplex regression and recovery.** In mock mode, perform a long monologue with natural pauses, interrupt assistant playback, resume after a cue boundary, mute/unmute the microphone, and force a close/reconnect. | Cues occur only at approved pauses; main playback ducks/restores without ending the call; stale audio/captions are rejected; captions track scheduled playback; completed turns do not replay the greeting. | Event timeline, playback/conductor snapshots, and categorized browser-console output. |
| H | **Staging acceptance and rollback.** Exercise token acquisition, WebSocket setup, AudioContext resume, denied microphone permission, TTS timeout/fallback, missing mapping, cache warm, jitter, ten-minute soak, telemetry, then disable V3 and start a new session. | Auth and audio paths work; failures are non-fatal; telemetry contains no private content; and the new session returns to V2 after rollback. Broad rollout remains blocked until sign-off. | Staging run ID, sanitized counters, rollback screenshot, and release-owner approval. |

## Pass/fail and evidence rules

A failed privacy or safety case blocks the candidate regardless of the automated score. A cue marked **fail** or **unsure** blocks the persona gate until the reviewer resolves the issue. The review page is a diagnostic surface and must not be treated as a deployment control.

Save only sanitized review metadata in `artifacts/voice-persona-review/`, which is ignored by Git. Do not save raw microphone audio, PCM buffers, full transcripts, prompts, auth headers, provider tokens, or secret voice IDs in the repository, screenshots, or exported JSON. Reviewer comments may themselves contain sensitive text and must be handled accordingly.

## Sign-off record

| Area | Result | Reviewer/date | Notes |
|---|---|---|---|
| Automated validation | Passed in release-candidate run |  | 15 V3 test files / 75 tests; backend 186 tests. |
| Memory and privacy | Pending cases B–E |  |  |
| Persona identity and audio quality | Pending case F |  |  |
| Full-duplex behavior | Pending case G |  |  |
| Staging and rollback | Pending case H |  |  |
| Broad production decision | **NO-GO until all blockers close** |  |  |
