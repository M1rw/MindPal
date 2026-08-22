# Production Voice V3 Startup Failure

Observed on `https://mindpal-demo.vercel.app/` after clicking the production voice control:

`Error: Failed to fetch dynamically imported module: https://mindpal-demo.vercel.app/voice-v3/assets/runtime.js`

The production voice shell opens, but the V3 compatibility facade cannot load `/voice-v3/assets/runtime.js`. This is a packaging/serving failure that occurs before Firebase token acquisition. The earlier `fetch` Illegal invocation error was from the previous deployed bundle; the current production deployment exposes the next concrete failure: the stable runtime asset is missing or served at a different path.

The correct next step is to inspect the generated Vite output and the `build_voice_v3_for_vercel.sh` copy destination, then ensure `runtime.js` is copied into the served frontend asset directory and referenced with a cache-safe stable URL.

## Post-fix verification

After deployment `dpl_GW1ujrVjsJLiCCTVJtSSyWzd6pNE` became READY, direct navigation to `https://mindpal-demo.vercel.app/voice-v3/assets/runtime.js` returned the V3 runtime JavaScript successfully. The response contains `createVoiceV3Controller` and imports `./chunks/app-DOoLabSN.js`. This confirms the asset is now reachable at the production facade’s requested URL; the next check is the token request and transport startup from the live UI.

## Second production observation

After the new deployment, the live UI still shows `Failed to fetch dynamically imported module: https://mindpal-demo.vercel.app/voice-v3/assets/runtime.js` when Voice is clicked. Direct navigation confirms both `runtime.js` and its first relative dependency `assets/chunks/app-DOoLabSN.js` are served as JavaScript. Therefore, the browser error likely represents module evaluation failure or another nested dependency failure, not simply a missing runtime.js file. The next step is to inspect all relative imports in the runtime chunk and test the production bundle in a clean module-loading context.

## Root-cause isolation and remediation

The response headers are valid for native ESM (`content-type: text/javascript; charset=utf-8`) and both generated modules evaluate successfully in a clean local module loader. The failure is therefore not a missing file, wrong MIME type, missing relative chunk, or a local syntax/evaluation error. The production facade will stop using `import()` and instead inject the same-origin `/voice-v3/assets/runtime.js` as a native `<script type="module">`. The loader validates the existing `window.__MINDPAL_VOICE_V3_RUNTIME__` factory, appends a cache-busting version, removes failed script tags, and permits a clean retry. This keeps the runtime lazy while using the browser’s normal module-script loading path.

## Live browser checkpoint after commit 8f6d458

The main branch commit `8f6d458` produced Vercel deployment `dpl_ChdURzF3LsBAMMgjnnzRubqWP54T`, which reached `READY` in production. The live `/dist/app.bundle.js` contains `data-mindpal-voice-v3-runtime` and `voice-v3-runtime-20260822`; the cache-busted runtime request returns HTTP 200 with `text/javascript`. In My Browser, clicking Voice no longer shows the prior `Failed to fetch dynamically imported module` banner: the overlay reaches `Connecting…`. The overlay then returns to the home surface, so module loading is no longer the observed error, but the downstream startup result still requires investigation (likely token, permission, or transport startup). No Vercel server-side runtime errors were reported in the last hour.

A second and third live click on the new production build consistently opened the Voice overlay at `Connecting…` without the old dynamic-import error, then returned to the home screen. This confirms the facade now gets past the former module-loader failure. Because the overlay’s 3-second guest-auth path and 30-second exception path both close asynchronously, the exact downstream status is not visible in the delayed browser snapshot; the remaining issue is now below module loading and must be separated between Firebase token availability, microphone permission, and Gemini transport startup.

## Authentication check

The connected production browser is authenticated: the Account panel shows `Connected`, the user profile `Miljte`, and the Firebase account email. Therefore the short-lived Connecting state is not explained by the intentional guest-mode branch in `voice_live.js`; the remaining failure is in V3 startup after token acquisition, most likely microphone permission, AudioWorklet loading, or Gemini transport setup.

The Account panel in My Browser explicitly reports `Connected` for the active Firebase user. After closing settings, the home surface remains stable; the production voice control opens the Connecting overlay but does not expose the old module-import error. A standalone clean-browser module probe is now being run to verify the runtime asset itself under Chromium’s native ESM loader.

## Latest browser retry

With the Account panel confirming a connected Firebase user, a fresh Voice click again showed the overlay briefly, but the next page snapshot had returned to home without a visible concrete error. This is consistent with either the auth readiness timeout path or an asynchronous startup failure that the current UI snapshot misses. The standalone Chromium probe independently reports `runtime-module-ok` for the production runtime, so the module-loader remediation itself is verified.

## Backend correlation

Vercel production logs show four `GET /api/voice/token` requests on deployment `dpl_ChdURzF3LsBAMMgjnnzRubqWP54T`, all returning HTTP 200 and successfully receiving HTTP 200 from Gemini’s `auth_tokens` endpoint. One request took 8.28 seconds, but token issuance completed. This proves the authenticated browser reaches the backend and the remaining startup failure occurs after token acquisition, in client capture or the direct Gemini Live WebSocket handshake.

## Clean-page retry

After a cache-busted navigation, the authenticated browser again opened the Voice overlay at `Connecting…` with no dynamic-import error. The next diagnostic query will correlate this attempt with backend token logs and, if present, the client’s post-token startup failure.

## Current verification boundary

The exact production runtime passes a clean Chromium native-module probe (`runtime-module-ok`). The production browser is authenticated, and Vercel logs show successful Gemini auth-token creation. The live UI still transitions from `Connecting…` back to home without a surfaced error in the browser snapshot. This means the original dynamic-import blocker is fixed and the remaining issue is a separate client-side failure after token creation, which cannot be reliably diagnosed from the available browser snapshot alone because the browser console is not exposed by the current session interface.

## Deployment `ad3284d`

Commit `ad3284d` was pushed to `main` and Vercel marked deployment `dpl_8hgidqdzSFoWfQghFWLeKpm3diyD` READY for production. The public alias serves `/voice-v3/assets/runtime.js` as `text/javascript; charset=utf-8`, and the production `/dist/app.bundle.js` contains the cache-busted native module-script loader marker `voice-v3-runtime-20260822`. The runtime bundle exposes `createVoiceV3Controller`. The next check is the live authenticated browser after this deployment.

## Confirmed root cause

The final production browser retry exposed the exact failure: `WebSocket closed: 1007 Invalid JSON payload received. Unknown name "speechConfig" at 'setup': Cannot find field.` The V3 transport sent `speechConfig` as a sibling of `generationConfig`, while Gemini’s Live API schema requires it inside `generationConfig`. The setup builder also contained a duplicate conditional `systemInstruction` key that could overwrite the MindPal instruction when setup context existed. Both issues are corrected, and the exact transport test now asserts the valid schema.

## Confirmed setup-timeout cause

After the payload-schema fix, the browser reached the native runtime but reported `Gemini setupComplete timeout`. Google’s current WebSocket quickstart specifies `v1beta.GenerativeService.BidiGenerateContentConstrained` for ephemeral tokens, including when the model is `gemini-3.1-flash-live-preview`. The backend had selected `v1alpha` for Gemini 3.1 and `v1beta` only for the 2.5 fallback. The mapping is now `v1beta` for both models, with backend security and fallback tests updated to enforce this requirement.

## Confirmed setup acknowledgment parser bug

The v1beta deployment still showed `Gemini setupComplete timeout`, while the socket and token request were both successful. The Live API schema sends `setupComplete` as an empty message object (`{"setupComplete":{}}`), but the client parser only accepted the test-only boolean form (`{"setupComplete":true}`). The parser now accepts the documented object form and keeps boolean compatibility for existing mocks; the transport regression test now uses the real empty-object acknowledgment.

## External reference notes

Google’s official Live API WebSocket quickstart states that ephemeral tokens must connect through `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=...`; source: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket. The official API reference defines `setupComplete` as an output-only empty message object, not a boolean; source: https://ai.google.dev/api/live. Google’s ephemeral-token guide also states that ephemeral tokens only work with the Live API `v1beta` version and documents the `liveConnectConstraints` shape; source: https://ai.google.dev/gemini-api/docs/ephemeral-tokens. The Gemini 3.1 model page confirms `thinkingLevel` values such as `minimal` and the model’s Live API support; source: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview.

## Cache-busting and error observability checkpoint

The public HTML and app bundle now use versioned URLs, and live logs show the current `runtime.js` and `app-CQGnRunY.js` being fetched from the READY deployment. The production browser no longer reports the stale dynamic-module loader error, but the session still surfaces `Gemini setupComplete timeout`. The transport now rejects and reports explicit Gemini `error` / `serverError` frames immediately, with a regression test, so the next live attempt will expose the provider’s actual setup rejection if one is being ignored.

## Latest production diagnostic and code audit (2026-08-21)

Deployment `dpl_9iDxzKuGYRipBrJt15YDomAMrNjU` for commit `3488606` reached READY. The authenticated browser fetched the current `runtime.js` and `app-EWyjxJSX.js` from that deployment, obtained a 200 ephemeral token from `/api/voice/token`, opened the Gemini socket, and still displayed `Error: Gemini setupComplete timeout` after 15 seconds. Vercel runtime logs show no provider error frame or socket-close event before the client timeout.

Google’s current Live API documentation confirms the ephemeral-token endpoint must be `v1beta...BidiGenerateContentConstrained`, the setup model uses `models/{model}`, `speechConfig` belongs inside `generationConfig`, and `setupComplete` is an empty object. The active V3 transport handles the empty object, but the V3 Gemini adapter still only accepted the old boolean form; that mismatch is now patched with a regression test. The active V3 app also has infrastructure for server-issued fallback grants, but the production composition root does not currently wire the grant callback, so a silent primary handshake cannot use the configured Gemini 2.5 fallback.

The remaining production uncertainty is whether Gemini is silently rejecting or not acknowledging the primary constrained session, or whether the absence of an adapter readiness event contributes to the observed failure. The next safe change is to deploy the adapter parser correction plus explicit fallback/diagnostic wiring, then retest only on the main production alias.

References: https://ai.google.dev/api/live; https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens; https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket; https://ai.google.dev/gemini-api/docs/live-api/capabilities.


## Confirmed stale production bundle on `a44a2e2`

The first browser test against deployment `dpl_3qidy1sdZKSgmyw7V5SDcStDyHFM` did not exercise the new code. The live overlay explicitly displayed `MindPal Voice V3 runtime failed to load: .../runtime.js?v=voice-v3-runtime-f71bc37`; `frontend/js/voice_session.js` and `frontend/index.html` still contained the prior `f71bc37` cache keys. This is a confirmed deployment-cache bug, not evidence that the fallback logic failed. Both keys and the loader regression test are now updated to `a44a2e2`; a follow-up commit and production deployment are required before retesting.

## Fallback lifecycle finding after cache correction

After deployment `dpl_EcYbEmgX4RUgzanbXnu9Tq5hAS77` for `f1253e5` became READY, the browser no longer showed the stale runtime-load error. The active production attempt reached the V3 overlay but ended with `Error: transport did not become ready`. Production logs confirmed two successful `/api/voice/token` calls and the current V3 assets from that deployment, which is consistent with the newly added primary-to-fallback path being exercised. The transport timeout cleanup used `close()` in a way that marked the old socket as user-closed while its close event could still race the fallback connection. The follow-up patch detaches the old socket before fallback token acquisition, uses a local connection promise, and adds a regression test for timeout → fallback setup completion.

## Confirmed module-graph failure and self-contained runtime fix

On deployment `dpl_Ce8y9gKuLaEGeAJvNaJZs3fZ8DQM`, the browser error changed to `runtime.js?v=voice-v3-runtime-a44a2e2` but still reported that the module failed to load. Direct HTTP checks showed `runtime.js` and its imported `chunks/app-gDRZUg38.js` both returned status 200 with JavaScript MIME types, while the browser module-script path still failed. The Vite output confirmed that the injected runtime was a 4.5 KB entry importing a separate shared chunk. The Vercel build now performs a second runtime-only Vite pass; with one entry, Vite emits a self-contained approximately 102 KB `runtime.js` with no `from` or dynamic-import specifiers. This removes the fragile transitive module graph from the direct browser-injected asset and is the next production fix to verify.

## Protocol correction: documented WebSocket service path

Google’s current official Live API reference documents the v1beta WebSocket endpoint as `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`. The official ephemeral-token guide also shows `liveConnectConstraints` as a token-creation restriction, while the client connects through the normal `BidiGenerateContent` service. MindPal was returning `BidiGenerateContentConstrained` in the token response, so both the primary and fallback browser sessions could obtain tokens but never receive `setupComplete`. The backend URL builder and its security/fallback tests are being updated to the documented endpoint.

## Decisive ephemeral-token endpoint correction

The standard `BidiGenerateContent` trial produced the concrete provider error `WebSocket closed: 1008 Method doesn't allow unregistered callers (callers without established identity)`, confirming that the normal service does not accept this browser token path. Google’s official ephemeral-token example client and the Google AI Developers Forum resolution specify `BidiGenerateContentConstrained?access_token=...` for ephemeral-token WebSocket sessions. The constrained endpoint is therefore restored. The token provisioning request is also corrected to bind `live_connect_constraints.model` as the full `models/{model}` resource name, matching Google’s REST example and the setup frame. Regression coverage now rejects the normal endpoint and verifies resource-name normalization.

## Minimal setup payload correction

After the constrained endpoint and full model resource name were deployed, the authenticated browser still reached `Gemini setupComplete timeout`. Google’s current v1beta WebSocket reference lists `generationConfig` fields such as `responseModalities` and `speechConfig`, but not the model-specific `thinkingConfig` previously added by MindPal. The transport now sends the minimal native-audio setup without `thinkingConfig`; its regression test verifies that both the primary and fallback setup frames omit that field while retaining model URI, voice, transcription, activity detection, and session resumption configuration.

## Minimal constrained setup experiment

The current browser result after the documented constrained endpoint, normalized model binding, and removal of `thinkingConfig` remained `Gemini setupComplete timeout`. To isolate the handshake contract, the transport was reduced further to the official minimum: `model`, `generationConfig.responseModalities`, native-audio `speechConfig`, and `systemInstruction`. Input/output transcription, automatic activity detection, and session-resumption setup fields were removed for this probe. Local transport and backend regressions pass; production verification of this narrower frame is the next gate. These optional capabilities must be reintroduced only after the provider handshake is confirmed.

## SDK-native constraint model format experiment

The minimal constrained setup still timed out in production, and production logs confirmed both the primary and fallback token exchanges completed with HTTP 200. The current experiment changes only the model value sent inside `live_connect_constraints`: it now uses the bare model ID, matching Google’s official Python SDK ephemeral-token example and the SDK’s direct serialization behavior. The browser setup frame continues to use the required `models/{model}` resource name. This isolates whether the REST-style resource prefix was invalid for the Python SDK token-creation request.

## Provider-default voice isolation experiment

The bare-model constraint experiment also timed out in production, with primary and fallback token exchanges both returning HTTP 200. The next probe removes only `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`, leaving `models/{model}`, `responseModalities`, `systemInstruction`, and `sessionResumption` intact. The purpose is to determine whether the selected persona voice is unavailable or incompatible with the active preview model. The transport regression now explicitly verifies provider-default voice behavior while preserving cue-text coverage.

## Access-token resource-path correction

Google’s current ephemeral-token documentation states that a raw WebSocket client passes `token.name` through the `access_token` query parameter. Gemini token names are resource-like values such as `authTokens/abc123`; the transport now preserves `/` while percent-encoding other token characters. A focused regression verifies `authTokens/abc+123` becomes `access_token=authTokens/abc%2B123`. The production facade and HTML app bundle receive a new cache key so this URL fix is guaranteed to reach Chromium.
