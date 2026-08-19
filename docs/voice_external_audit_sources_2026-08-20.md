# Voice external audit sources

## Vercel WebSockets

Source: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
Retrieved 2026-08-20. Vercel states that Vercel Functions natively support WebSocket connections for realtime features. Established connections are pinned to the accepting Function for its maximum duration; future connections are not guaranteed to reach the same Function instance. Durable state across reconnects should use external storage such as Redis.

Source: https://vercel.com/docs/functions/websockets
Retrieved 2026-08-20. Vercel states that a WebSocket upgrade passes through normal routing/security controls, messages on an established connection reach the same Function instance for that connection, and connections close when the Function reaches its maximum duration. Clients must reconnect and reload state. Durable state, presence, counters, rooms, and pub/sub coordination should not depend on in-memory state. WebSockets use Vercel Function limits/pricing and require Fluid Compute; new projects created after April 23, 2025 have Fluid Compute enabled by default.

## Vercel limits

Source: https://vercel.com/docs/functions/limitations
Retrieved 2026-08-20. With Fluid Compute, maximum duration is 300 seconds on Hobby, 800 seconds on Pro/Enterprise, with an extended 1800-second option under the documented beta conditions. Edge Functions must begin a response within 25 seconds for streaming beyond that point and can stream up to 300 seconds. Function request/response payload size is 4.5 MB. Standard uncompressed function size is 250 MB, or 500 MB for Python. These limits matter for long-lived voice connections and prohibit proxying raw audio through ordinary request bodies.

## Gemini Live ephemeral tokens

Source: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
Retrieved 2026-08-20. Gemini ephemeral tokens are short-lived credentials for direct browser-to-Live-API WebSocket connections. The intended flow is: authenticated client calls backend; backend provisions token; backend returns token to client; browser connects directly to Gemini. Tokens can be locked to a model/configuration, and a token with uses=1 can still be used for session resumption within its expiration window. The direct client-to-server path improves latency and avoids routing realtime audio through the backend.

## Gemini Live capabilities

Source: https://ai.google.dev/gemini-api/docs/live-api/capabilities
Retrieved 2026-08-20. Gemini Live input is raw PCM audio and output is raw 24 kHz PCM. Automatic VAD supports configuration and custom activity boundaries. VAD interruption cancels/discards ongoing model generation and clients should stop/clear queued audio. The page documents model-specific setup and transport differences; Gemini 2.5 supports clientContent throughout the conversation, while Gemini 3.1 uses realtimeInput for post-setup text. The production trace in pasted_content_4.txt independently shows this deployed endpoint rejects enableAffectiveDialog at setup with close code 1007, so optional setup fields must be fail-safe or omitted for this constrained transport.

## Current trace finding

User attachment pasted_content_4.txt, 2026-08-20: the browser reaches socket-open with setupSent=true, then the provider closes with code 1007 because setup contains unknown name enableAffectiveDialog at setup. This is a provider schema/setup failure before setupComplete, not a VAD, WebSocket latency, or browser audio failure. The current provider policy still returns enableAffectiveDialog for Gemini 2.5 and therefore requires immediate removal/gating before duplex testing can be meaningful.

## Audit implication

MindPal’s current architecture is client-to-Gemini WebSocket with a Vercel backend used for auth, ephemeral-token provisioning, diagnostics, and verified tools. It is not proxying PCM through a Vercel Function. This is the correct low-latency topology for the documented Gemini ephemeral-token flow. The main platform risks are connection duration/reconnect continuity, stale deployment caching, and provider setup schema drift—not a standard Vercel serverless WebSocket proxy in the current code path.

## References

[1]: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
[2]: https://vercel.com/docs/functions/websockets
[3]: https://vercel.com/docs/functions/limitations
[4]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
[5]: https://ai.google.dev/gemini-api/docs/live-api/capabilities


## Post-fix verification

Commit dd824a8 removed both optional setup fields from the Gemini 2.5 constrained WebSocket payload and changed the HTML asset query from rich-response-20260814 to voice-duplex-20260820. A direct HTTP fetch of https://mindpal-demo.vercel.app/?v=voice-duplex-20260820 returned HTTP 200 with cache-control: no-cache and the new asset references. Vercel deployment dpl_AcrRKBX9kxEhWdvG1C8Wyv8FQC9n is READY. Vercel grouped runtime errors for the last two hours returned no runtime errors.

The deterministic synthetic suite has four passing tests. It validates mono PCM16 16 kHz fixtures, mute suppression, background-noise rejection before sustained speech, optimistic ducking/release driven by real orchestrator capture-quality handling, and a 10.4-second story pause entering the 180-1200 ms listening-cue eligibility window without requiring a user yield. The synthetic interruption harness observes ducking within one 20 ms capture frame and release after the interruption gap.

The connected browser extension timed out while trying to close the persisted Settings modal during the final cache-busted browser check. Therefore, direct HTTP freshness and Vercel runtime-error absence are verified, while a human-spoken long-story cue test remains unverified in this pass.
