# MindPal Hardened Release Changelog

## Security

- Replaced permanent Gemini browser credential delivery with authenticated one-use ephemeral Live tokens.
- Retired `/api/voice/key` with HTTP 410.
- Added DOMPurify rich-output sanitization and text-only streaming.
- Added CSP, anti-framing, MIME sniffing, referrer, permissions, COOP/CORP, and HSTS support.
- Removed executable third-party CDN dependencies from the production page.
- Added same-origin production CORS default.
- Added deterministic frontend security audit and voice-secret regression tests.

## Chat and streaming

- Removed duplicate current-message transmission.
- Bounded and normalized history payloads.
- Rebuilt SSE framing/error/timeout/abort handling.
- Prevented aborted or partial generations from becoming persisted replies.
- Captured request model/accounting state to avoid model-switch races.
- Added safe regeneration usage tracking.
- Removed chain-of-thought/internal “Thought” content from visible output.

## Memory V3

- Made Memory Graph V3 canonical across app, local persistence, inspector, and cloud sync.
- Removed continuous dual writes to legacy memory.
- Added one-time migration, stable keys, safer person identity, tombstone reactivation, dedupe, retention, and bounded merge work.
- Added user-scoped cloud hydration and queued retrying writes.

## Voice

- Added ephemeral-token startup and constrained Live WebSocket endpoint.
- Added 16 kHz resampling, AudioWorklet pull path, ScriptProcessor fallback, and graph cleanup.
- Added bounded reconnect, token refresh, session resumption, context compression, GoAway handling, setup gating, and audio stream end.
- Migrated to `realtimeInput.audio`.
- Disabled privacy-leaking client web-search fallback during voice tool execution.
- Deduplicated cumulative/delta transcripts.
- Corrected “Incognito” semantics to “Do not save this call.”

## Performance and delivery

- Added reproducible npm build with pinned Firebase, Lucide, DOMPurify, Tailwind, and esbuild.
- Compiled Tailwind at build time.
- Tree-shook Lucide to the icons actually used by MindPal.
- Bundled application dependencies locally.
- Replaced repeated rich stream renders with text preview plus one final sanitized render.
- Replaced O(n²) typewriter HTML rebuilding with text-node animation.
- Bounded/deferred local persistence and batched cloud sync.
- Consolidated local/serverless frontend route serving.

## Testing and operations

- Fixed pytest collection boundaries.
- Added frontend delivery/CSP tests.
- Added ephemeral-token and retired-secret endpoint tests.
- Added frontend asset, icon, inline-script, forbidden-secret, and syntax audit.
- Added PowerShell release verification and safe deployment scripts.
