# Voice V4 Layer 7 — Readiness and Go/No-Go Report

**Date:** 27 August 2026
**Status:** **NO-GO for live acceptance; implementation ready and protected-preview pending**

## Executive result

Layer 7’s deterministic acceptance harness, redacted evidence collector, and preview-only session composition are implemented locally. The local contract, redaction, ordering, authenticated token-request wiring, frontend audit, and production-bundle checks pass. The real-browser Gates A–F were **not executed**, because the available `mindpal-demo.vercel.app` address is the production deployment and no verified protected preview URL was available.

This is the correct safe outcome. A production page must not be converted into a live Voice test target, and no production account access or Voice feature state was changed.

## Local verification

| Check | Result |
| --- | --- |
| Layer 7 deterministic tests | **6 passed** |
| Complete JavaScript suite | **74 passed, 0 failed** |
| Syntax/import integrity | **Passed; 111 Python files, 80 JavaScript files, 8 JSON files, 122 relative imports, 0 failures** |
| Frontend structural/security audit | **Passed; 67 JavaScript files, 115 DOM IDs, 10 assets, 50 icon names** |
| Production frontend build | **Passed; 4 required non-Voice outputs verified** |
| Whitespace hygiene | **Passed** |

The acceptance harness is committed as `76ed47e Implement_voice_v4_layer7_preview_harness`. The local preview-only session wiring is committed as `b9e0be8 Implement_voice_v4_layer7_preview_wiring`. It is intentionally gated by `ENVIRONMENT=staging`, `VOICE_V4_PREVIEW_APPROVED=true`, and `VOICE_V4_PREVIEW_SESSION_ENABLED=true`; production publishes false values.

## Non-invasive production check

The current `mindpal-demo.vercel.app` page was opened for observation only. The Voice control reported **Voice input unavailable**. No Voice control was clicked. No microphone permission was requested, no Voice token was issued, and no provider WebSocket was opened.

The deployed project metadata identifies `mindpal-demo.vercel.app` as the production domain, and the current deployment target is production. Historical deployment URLs from older branches were not treated as valid Layer 7 targets because their environment, version, feature state, and access controls were not verified as a current protected preview.

This check proves only that production remains fail-closed. It is not evidence for any of Gates A–F.

## Gate status

| Gate | Result | Reason |
| --- | --- | --- |
| A — Browser capability | **Not run** | No protected preview target |
| B — Identity and token | **Not run** | No protected preview target; production token issuance is out of scope |
| C — Provider setup | **Not run** | No protected preview target; the live session factory is intentionally disabled in the production composition root |
| D — Actual input | **Not run** | No real microphone session was started |
| E — Actual output | **Not run** | No real provider output was scheduled or heard |
| F — Interruption | **Not run** | No live audible output existed to interrupt |

No gate is marked passed based on indirect evidence. In particular, the local test harness is proof of the acceptance logic, not proof that Google Live, a microphone, or speakers work in a real browser.

## Blocking conditions

A genuine Layer 7 run requires a separate access-controlled `preview` or `staging` deployment, an explicitly targeted `voice.live_v4` flag, a verified bundle version, a verified model and token endpoint, and the preview-only session factory that connects the approved Layers 1–5. The local composition now contains that factory behind explicit staging-only runtime flags. The normal production runtime publishes those flags as false, so the production app cannot request microphone permission or open the provider session.

Creating or enabling such a preview would be a separate deployment/configuration action and is not included in this report. It requires explicit approval because it creates a live external deployment and may expose a microphone-enabled test path to the selected cohort.

## Safe next step

Provide an existing protected preview URL, or explicitly approve creating a dedicated protected preview deployment from an isolated branch. Once a verified preview exists, the real-browser run can proceed in order through Gates A–F after confirmation. If any gate fails, the run stops immediately and the result remains a no-go; no reconnect, prompt manipulation, fake audio, prerecorded WAV, or diagnostic overclaim is permitted.

Layer 8 dynamic affect, feelings, prompt adaptation, memory, tools, reconnect, and session resumption remain out of scope until the transport baseline passes the real-browser acceptance gates and receives separate approval.
