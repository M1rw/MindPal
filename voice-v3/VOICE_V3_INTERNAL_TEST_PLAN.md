# MindPal Voice V3 Internal Test Plan

**Scope:** Sprint 15 Local Voice Memory and the internal Voice V3 release candidate. **Owner:** Manus AI. **Audience:** MindPal engineering, QA, and human voice reviewers.

## Purpose and safety boundary

This plan validates the isolated `voice-v3/` engine and its review tooling. Voice V2 remains the production path during this test cycle. Testers must not enable a broad rollout, paste provider secrets into the browser, or commit generated audio, review comments, tokens, or environment files. Use a dedicated test user when persistence behavior is being verified.

The release candidate is considered **test-ready** when the automated checks pass, the manual cases below have recorded evidence, every configured persona sample has been listened to by a human, and all launch blockers are either closed or explicitly accepted by the release owner.

## Preconditions

Use a local or staging deployment with an authenticated session, a working microphone, browser permission granted only to the intended origin, and `VOICE_V3_ENABLED=false` as the safe default. For memory cases, use a unique `memoryUserId`; for incognito cases, use a separate session or clear the record before starting. For persona review, configure only real provider voice IDs in backend secrets and never place those IDs or tokens in committed files.

Run the deterministic checks before manual work:

```bash
cd voice-v3
npm run check
npm test -- --run
npm run build
cd ..
pytest -q
python3 -m py_compile backend/api/voice_router.py
```

## Test cases

| ID | Manual test | Procedure | Expected result | Evidence |
|---|---|---|---|---|
| A | Feature-flag matrix and V2 safety | Run with `VOICE_V3_ENABLED=false`, then with V3 enabled only in the isolated/debug harness. Exercise start, stop, mute, captions, and reconnect. | With the top-level flag off, V3 does not create its app and V2 remains responsible for voice. No V2 production file is changed by the test. | Flag values, console excerpt, and route/build identifier. |
| B | Explicit memory extraction | Say: “My name is Marwan. I work at MindPal. I am building Voice V3. I prefer concise answers. I don’t like static audio assets.” End the turn. | The debug panel shows only normalized facts/preferences, extraction count increments, and no raw transcript is emitted as a memory event. Hedged language such as “Maybe I like dark mode” is ignored. | Screenshot of memory panel and sanitized event list. |
| C | Local persistence, bounds, and deletion | Add more than 20 facts and more than 20 preferences across turns. Stop and restart with the same `memoryUserId`; then press **Clear memory**. | The newest 20 entries remain per category, the record survives restart in IndexedDB, the setup context is bounded to five facts/five preferences and 500 characters, and Clear memory removes the record. | Before/after snapshots; browser IndexedDB record count, with content redacted if shared. |
| D | Incognito and disabled memory | Run once with `incognito=true`, once with `VOICE_V3_MEMORY_ENABLED=false`, and speak explicit memory statements. Reconnect each time. | Neither mode reads, injects, stores, nor publishes memory snapshots containing user content. The voice session otherwise remains functional. | Configuration and sanitized network/event evidence. |
| E | Setup injection and isolation | Preload a record, start a real or mock session, and inspect the outbound setup payload in a controlled test environment. Repeat with an empty record. | Non-empty context appears only under `setup.systemInstruction.parts[0].text`; empty, disabled, and incognito sessions send no `systemInstruction`. Audio and transcript payloads are not used to populate setup context. | Redacted setup JSON and transport test result. |
| F | Persona and cue listening review | Open `/voice-v3-review`. Confirm catalog metadata, then fetch `mhm`, `yeah`, `aha`, `right`, and `okay` for Kore and Charon. Play every returned sample and mark pass/fail/unsure with comments. | Missing mapping is shown as `REQUIRED` and does not invent a voice. Configured responses show duration, cache/fallback metadata, and audible mono 24 kHz PCM16 output. Exported JSON contains review metadata but no credentials. | Exported review JSON under ignored artifacts path plus signed-off reviewer name/date outside the repository. |
| G | Full-duplex regression and recovery | In mock mode, perform a long monologue with natural pauses, interrupt an assistant response, resume after a cue boundary, mute/unmute the microphone, and force a transport close/reconnect. | Backchannel cues are eligible only during approved pauses, main playback ducks and restores without ending the call, stale audio/captions are rejected, captions remain synchronized to scheduled playback, and a completed turn does not replay the greeting. | Event timeline, playback/conductor snapshots, and browser console errors (expected diagnostic logs separated from failures). |
| H | Staging acceptance and rollback rehearsal | In staging only, exercise token acquisition, WebSocket setup, AudioContext resume, microphone denial/retry, TTS timeout/fallback, missing mapping, cache warm, network jitter, ten-minute soak, and the telemetry endpoint. Then set V3 off and start a new session. | All required auth and audio paths work, failures are non-fatal, no private content reaches telemetry, and a new session returns to V2 after rollback. Broad rollout remains blocked until human review and launch-gate prerequisites pass. | Staging run ID, sanitized metrics, rollback screenshot, and release-owner sign-off. |

## Pass/fail rules

A case passes only when the expected result is observed and its evidence is recorded. A failure involving privacy leakage, stale audio playback, accidental V2 modification, an invented persona voice ID, or an inability to roll back is immediately blocking. A sample marked **fail** or **unsure** blocks the human voice gate until reviewed and resolved.

## Evidence handling

Store only non-sensitive review artifacts in `artifacts/voice-persona-review/`; this path is ignored by Git. Do not store raw microphone audio, PCM buffers, full transcripts, prompt content, auth headers, provider tokens, or secret voice IDs in the repository, issue tracker, screenshots, or exported JSON. Keep staging logs sanitized to counters, state names, bounded error codes, and deployment identifiers.

## Sign-off record

| Area | Result | Reviewer / date | Notes |
|---|---|---|---|
| Automated validation | Pending until final release-candidate run |  |  |
| Local memory and privacy | Pending manual cases B–E |  |  |
| Human persona voice identity | Pending case F |  |  |
| Full-duplex behavior | Pending case G |  |  |
| Staging and rollback | Pending case H |  |  |
| Release decision | **NO-GO for broad rollout until all blockers close** |  |  |
