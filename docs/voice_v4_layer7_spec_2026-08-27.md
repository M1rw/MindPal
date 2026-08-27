# Voice V4 Layer 7 — Protected Preview and Live Acceptance

**Status:** Layer 7 verification implementation. Production Voice V4 remains disabled. This document authorizes no deployment, production enablement, merge, or live microphone/provider operation without a separate confirmation.

**Author:** Manus AI
**Date:** 27 August 2026
**Scope:** Real-browser acceptance of the already implemented Voice V4 Layers 0–6 baseline.

## 1. Responsibility

Layer 7 owns the acceptance boundary between deterministic local implementation and a protected real-browser preview. It defines the ordered Gates A–F, the evidence required for each gate, safe in-memory evidence collection, stop-on-failure behavior, and the final go/no-go record.

Layer 7 does **not** add dynamic feelings, adaptive prompts, memory, tools, reconnect logic, session resumption, production activation, or a second voice runtime. It does not treat a UI label, transcript, socket object, byte counter, or queued PCM as proof of a human-audible conversation.

> **Operating rule:** A gate passes only on evidence produced by the fact that gate measures. Evidence from another layer may support investigation, but it cannot substitute for the required proof.

## 2. Protected preview requirements

A real-browser run is permitted only when all of the following are true and directly checked immediately before testing:

| Requirement | Required condition | Failure action |
| --- | --- | --- |
| Environment | Explicitly non-production `preview` or `staging` environment | Stop before opening the Voice surface |
| Access | Authenticated, access-controlled preview cohort | Stop before token testing |
| Version | Deployed bundle identifier is recorded | Stop if version cannot be identified |
| Feature | `voice.live_v4` is explicitly enabled for the targeted cohort only | Stop if the flag is missing or broad |
| Release | Layer 0 decision is allowed only for the protected non-production environment | Stop if production or an unknown environment is detected |
| Provider | Model identifier and token endpoint are recorded as safe metadata | Stop if the target cannot be verified |
| Privacy | Evidence collector stores only the approved bounded fields | Stop and discard the run if redaction fails |

The active application must continue to fail closed in production. The Layer 7 composition root may construct a session factory only when the backend publishes `ENVIRONMENT=staging`, `VOICE_V4_PREVIEW_APPROVED=true`, and `VOICE_V4_PREVIEW_SESSION_ENABLED=true`; the adapter independently rejects production and non-preview environments. The normal production runtime publishes false values, so it cannot request microphone permission or open a provider socket. Layer 7 must not change that behavior as part of local wiring work.

## 3. Gates A–F

Each gate is started in order. A failed gate makes the run terminal and blocks every later gate. A passing gate does not retroactively prove an earlier gate and does not permit skipping the next gate. A run is a **go** only if all six gates pass in one protected-preview session and the evidence record is complete.

| Gate | Required evidence | Explicit non-evidence |
| --- | --- | --- |
| **A — Browser capability** | Secure context, microphone permission state, AudioWorklet availability, AudioContext availability, and an active capture graph are verified in the real browser | A button click or an unresolved `getUserMedia` promise |
| **B — Identity and token** | Authenticated request, constrained token, short-lived token, and a clean browser secret scan are verified without recording the token | HTTP 200, mock token, or inspecting a server-side key |
| **C — Provider setup** | Exactly one socket opens, exactly one setup envelope is sent, `setupComplete` is observed, and zero realtime audio frames were sent before setup completion | A socket object, a connecting label, or a setup message without the provider acknowledgement |
| **D — Actual input** | Real microphone speech, produced capture frames, frames sent after setup, provider input transcription, and a semantically relevant response are all observed | A frame counter, prerecorded WAV, local transcript, or synthetic provider event |
| **E — Actual output** | Provider audio is received, decoded, scheduled, drained, and confirmed genuinely audible by the user | Output transcript, received bytes, queue depth, scheduled source, or “speaking” label |
| **F — Interruption** | User speech occurs while output is genuinely audible; provider interruption is observed, playback is flushed, the next turn works, and cleanup is observed | Synthetic interruption, a button action, or a UI state change without audible output |

The evidence contract uses booleans for required facts and bounded non-sensitive counters for supporting facts. It intentionally excludes transcript text, prompts, token material, authorization data, raw PCM, microphone content, provider response bodies, full provider URLs, and personal targeted data.

## 4. Abort conditions

Testing stops immediately if any gate fails, if the environment is production or cannot be verified, if the token or authorization data appears in browser-visible evidence, if a diagnostic contains raw content, if more than one session owner or provider socket is observed, if audio is sent before setup completion, or if the user reports that output is not genuinely audible. The correct result is a failed gate and implementation review; speculative reconnects, buffering, prompt changes, or UI claims must not be added to conceal the failure.

The user may stop the run at any time. Stopping must close capture, playback, and the socket, clear captions and diagnostics, invalidate the session generation, and leave the feature in its inactive state. A failed run is not retried automatically.

## 5. Evidence schema and retention

The Layer 7 collector is in-memory only. Each entry contains a safe run identifier, gate identifier, safe event category, bounded timestamp, allow-listed lifecycle fields, required boolean facts, and bounded counters. Evidence is not written to local storage, URL parameters, analytics, server logs, or committed fixtures. Any final report contains only aggregate gate status and safe metadata.

The pure gate state machine is responsible for ordering and pass/fail decisions. The evidence collector is responsible for allow-listing and bounded values. Neither module calls the network, opens browser APIs, requests permission, or starts a voice session.

## 6. Repository map

The Layer 7 module follows the project’s feature boundary convention:

| File | Responsibility and technology choice |
| --- | --- |
| `frontend/js/features/voice_v4/layer7/gates.js` | Pure ordered Gate A–F state machine with immutable snapshots and fail-stop transitions; browser-independent ES module |
| `frontend/js/features/voice_v4/layer7/evidence.js` | In-memory bounded evidence collector reusing the Layer 0 sanitizer; browser-independent ES module |
| `frontend/js/features/voice_v4/layer7/index.js` | Public gatekeeper for the Layer 7 feature module; internal files remain replaceable |
| `frontend/js/features/voice_v4/layer7/preview_session_factory.js` | Preview-only composition adapter for Layer 1 token provisioning, direct Google WSS, Layer 3 capture, Layer 4 playback, and Layer 5 orchestration; it returns no factory outside staging/preview |
| `tests/test_voice_v4_layer7.mjs` | Deterministic tests for ordering, missing evidence, failure stop, redaction, immutable snapshots, and preview-only composition; Node test runner |
| `docs/voice_v4_layer7_spec_2026-08-27.md` | Acceptance contract, privacy boundary, gate checklist, and handoff record |

## 7. Exit criteria

Layer 7 implementation is complete when the pure harness tests pass, syntax/import and frontend audits pass, the production bundle remains inactive, and a protected preview is available for a separately confirmed real-browser run. Layer 7 acceptance is complete only after Gates A–F have been executed with real browser, real microphone, real provider, and human audibility confirmation. Until then, the correct status is **implementation ready; live acceptance pending**.

A passing Layer 7 run authorizes neither production deployment nor Layer 8 behavior work by itself. A separate release decision is required before any rollout, and Layer 8 remains out of scope until the transport baseline has passed the real-browser gates.
