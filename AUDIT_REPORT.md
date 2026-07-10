# MindPal Frontend Security, Logic, Performance, and Architecture Audit

Audit target: full repository supplied as `MindPal.zip`.
Release target: hardened frontend and its backend integration boundary.

## Release decision

The original frontend was not production-ready. It had one critical credential exposure, multiple high-impact state and streaming bugs, and a deployment route map that could serve the HTML while returning 404 for required runtime assets.

The hardened release removes the confirmed critical path and passes the automated release gates included in this repository. Real Gemini Live microphone testing and Firebase production-rule validation still require the deployed environment and real credentials.

## Confirmed findings and remediation

| Severity | Finding | Impact | Hardened state |
|---|---|---|---|
| Critical | Browser requested a permanent Gemini API key from `/api/voice/key` and placed it in the WebSocket URL | Any authenticated browser could extract and reuse the provider credential | Replaced with authenticated, one-use Gemini Live ephemeral tokens; permanent-key endpoint returns HTTP 410 |
| Critical | Frontend delivery mounted only `/css` and `/js` although the page required runtime config, assets, and production bundles | Deployments could partially load or fail unpredictably | One deterministic FastAPI route map serves `/`, `/runtime-config.js`, `/css`, `/js`, `/dist`, `/assets`, PWA files, and Vercel entrypoint |
| High | Current user prompt was placed in history and also sent as the separate message | Duplicate model input, repeated answers, incorrect token usage | Request history is bounded and trailing duplicate user content is removed |
| High | Abort/cancel could fall through to a fallback response and persist it into a different or newly reset conversation | Phantom replies and cross-conversation state corruption | Abort and timeout are distinct terminal states; cancelled streams are not persisted |
| High | Memory V3 returned a graph while `app.js` still consumed legacy flat fields; the same message could be classified twice | Memories disappeared, duplicated, or became `undefined` | Memory Graph V3 is the single canonical state; one classification/write path remains |
| High | Model-generated rich HTML entered `innerHTML` through several sinks | XSS exposure if parser escaping regressed or adversarial output reached a sink | Streaming uses `textContent`; final rich output is sanitized through a strict DOMPurify allowlist; CSP provides a second boundary |
| High | Runtime JavaScript and CSS executed from Tailwind and Lucide CDNs | Supply-chain exposure, no effective strict CSP, runtime compilation overhead | Tailwind CSS, Lucide icons, Firebase, DOMPurify, and the app are pinned and built locally with a lockfile |
| High | Voice reconnect branch logged a retry but did not reliably open a new session; expired auth could be reused | Calls stalled permanently after network/auth failure | Bounded exponential reconnect, forced Firebase token refresh, session-resumption handles, and fresh ephemeral-token provisioning |
| High | Audio samples could be labelled 16 kHz without resampling; AudioWorklet fallback was missing/incomplete | Distorted recognition, silent microphones, browser incompatibility | Linear resampling to 16 kHz, connected AudioWorklet sink, and ScriptProcessor fallback |
| Medium | Deprecated Live API `mediaChunks` payload and older unconstrained key endpoint were used | Protocol drift and reduced reliability/security | Uses `realtimeInput.audio`, constrained v1alpha WebSocket endpoint, session resumption, context compression, and GoAway handling |
| Medium | SSE parser mishandled fragmented, multiline, CRLF, or unterminated events | Missing final chunks and silent stream errors | Incremental event framing, content-type validation, terminal-buffer flush, and typed error propagation |
| Medium | Full Markdown/HTML was rebuilt on every stream chunk and typewriter character | O(n²) DOM churn, jank, and long-response slowdown | Plain-text stream preview; one sanitized final render; text-node requestAnimationFrame typewriter |
| Medium | Local state writes serialized the entire growing chat synchronously and without robust quota recovery | UI pauses and storage failures | Bounded chat history, deferred writes, normalization, pruning, and one retry after quota failure |
| Medium | Cloud sync wrote both V3 and legacy memory continuously and could race hydration/queues | Divergent memory stores and stale overwrites | One-time legacy migration, V3-only writes, user-scoped hydration, batching, retries, and online flush |
| Medium | Memory merge identity used relationship labels too broadly and replacement could preserve tombstones | Different people merged; edited memories remained deleted | Stable canonical keys, safer people identity, replacement reactivation, bounded dedupe, and evidence inflation prevention |
| Medium | Repository-level `pytest` collected executable scratch scripts | Test command crashed before product tests ran | Pytest is scoped to `tests/` with strict configuration |
| Medium | Production wildcard CORS was only logged | Unnecessary cross-origin API surface | Production defaults to same-origin; external clients require an explicit allowlist |
| Low | “Incognito” toggle only prevented call-history persistence after the call had started | UI overstated privacy semantics | Relabelled as “Do not save this call”; no claim that model context or transport is anonymous |
| Low | Tree-shaken icon registry omitted numeric-name aliases such as `volume-2` | Some icons could remain blank | Kebab-case generation now handles numeric suffixes; icon coverage is release-tested |

## Security controls now present

- Strict `Content-Security-Policy` with self-hosted scripts, denied framing, denied objects, restricted network/frame/media/worker origins.
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP, CORP, and optional HSTS.
- No inline scripts in the production HTML.
- No executable Tailwind, Lucide, or Firebase CDN dependency.
- No permanent Gemini provider secret in browser configuration or WebSocket URLs.
- DOMPurify allowlist on model-generated rich HTML.
- Reproducible npm dependency graph through `package-lock.json`.
- `npm audit --omit=dev`: zero known vulnerabilities at audit time.
- Bandit: zero high-severity findings; two medium findings are intentional `0.0.0.0` server binding configuration, not hard-coded outbound exposure.

## Performance changes

- Runtime Tailwind compilation removed.
- Generated Tailwind CSS is approximately 35 KB minified.
- Lucide bundle is tree-shaken from roughly 392 KB to approximately 13 KB minified.
- Application/Firebase/DOMPurify bundle is approximately 332 KB minified.
- Stream rendering no longer reparses rich HTML per chunk.
- Typewriter rendering builds the DOM once and reveals text nodes in bounded animation frames.
- State persistence and cloud sync are bounded/batched.
- Voice audio conversion avoids repeated graph construction and cleans up nodes, streams, timers, sockets, and object URLs.

## Architecture after hardening

```text
frontend/index.html
  ├─ runtime-config.js            public deployment config only
  ├─ css/tailwind.generated.css   build-time utilities
  ├─ css/style.css                product-specific components
  ├─ dist/lucide.bundle.js        tree-shaken icon registry
  ├─ js/bootstrap.js              loader/viewport/analytics queues
  └─ dist/app.bundle.js           bundled application + Firebase + DOMPurify

app.js
  ├─ api.js                       bounded HTTP/SSE transport
  ├─ ui_state.js                  canonical bounded UI/chat state
  ├─ memory_graph.js              Memory Graph V3
  ├─ cloud_sync.js                authenticated V3/chat synchronization
  ├─ components/*                 settings, models, usage, notifications
  └─ voice/*                      ephemeral-token Live API runtime

Browser voice
  ├─ Firebase identity → MindPal `/api/voice/token`
  ├─ one-use ephemeral Live token
  ├─ direct low-latency constrained Gemini Live WebSocket
  └─ backend-only tools through authenticated MindPal HTTP routes
```

## Verified release gates

- Python tests: 20 passed.
- Node regression tests: 7 passed.
- Frontend audit: 32 JavaScript files, 74 unique DOM IDs, 10 local assets, 45 icon names, build outputs, and forbidden security patterns checked.
- JavaScript syntax: passed.
- Python compile: passed.
- npm production dependency audit: zero known vulnerabilities.
- FastAPI static-delivery tests: root, runtime config, CSS, app bundle, icon bundle, and CSP passed.

## Remaining risks and required production validation

1. **Firebase rules and App Check are not verifiable from this repository.** Firebase browser configuration is public by design; Firestore/Auth security depends on server-side rules, authorized domains, quotas, and App Check enforcement.
2. **Guest conversations and memory remain in browser localStorage.** CSP and removal of foreign runtime scripts reduce exfiltration risk, but this is not encrypted at rest. A future privacy phase should move sensitive local data behind an explicit encrypted vault or disable durable guest history by default.
3. **Real browser voice E2E was not executable in this sandbox.** Chromium navigation is blocked by the environment administrator, and no real microphone/provider credential is available. Route tests, protocol tests, syntax checks, and static checks pass; production still needs Chrome/Edge/Safari device testing.
4. **Python dependency CVE lookup could not complete because the sandbox could not resolve PyPI during `pip-audit`.** Python tests and Bandit passed; rerun `pip-audit -r requirements.txt` in CI with network access.
5. **`app.js` remains a large orchestration module.** The runtime is now stable, but the next maintainability phase should extract chat, memory, auth, and conversation controllers behind typed interfaces.
6. **The heuristic `voice_emotion.js` module is archived and excluded from production.** Its heuristic labels are not reliable enough for clinical or safety decisions. Gemini receives the actual audio; safety escalation must continue to rely on backend policy and explicit user content, not fixed pitch/volume thresholds.
