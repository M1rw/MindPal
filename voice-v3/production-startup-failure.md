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
