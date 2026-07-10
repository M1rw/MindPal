# MindPal Backend V2 changelog

## Security

- Removed permanent Gemini-key delivery; added constrained ephemeral Live tokens.
- Added Firebase App Check verification to every authenticated request path and client integration to chat, profile/memory APIs, voice, summarization, and tools.
- Added production fail-closed checks for Firebase project identity, matching web/server project IDs, revoked-token verification, App Check, HSTS, trusted hosts, explicit CORS, remote providers, disabled anonymous access, and disabled offline fallback.
- Added pre-parser request-body limits, strict URL validation, sanitized errors/logging, CSP/security headers, no-store API responses, protected diagnostics, and an explicit admin custom-claim boundary.
- Removed executable CDN dependencies and sanitized model-generated rich HTML.

## Correctness and consistency

- Replaced check-then-charge quotas with atomic reserve/commit/refund accounting.
- Added stale-reservation recovery and idempotent operation IDs.
- Added atomic distributed rate limits and bounded per-user concurrency.
- Added atomic idempotency ownership, replay, payload-conflict detection, processing recovery, TTL fields, and response-size limits.
- Made Memory Graph V3 the sole writable source of truth with optimistic versioning and transactional merges.
- Made chat synchronization and profile updates transactional.
- Fixed duplicate prompt transmission, cancellation phantom replies, incomplete stream persistence, SSE framing, and response chunk loss.
- Fixed unresolved runtime names in chat streaming and authenticated tool inventory discovered by Ruff.

## Performance and architecture

- Added a per-application composition root and one pooled HTTP client shared by remote providers.
- Removed hidden global settings coupling and ad-hoc quick-provider paths.
- Bounded histories, memory graphs, tool arguments, stored voice metadata, and replay records.
- Added deterministic production frontend builds and deployment-generated runtime configuration.
- Added exact Python runtime lock, npm lock, and a separate development/security lock.

## Verification

- Python tests include quota concurrency, stale recovery, idempotency replay/conflicts, memory lost-update prevention, stale-device rejection, document caps, body-size rejection, request-ID consistency, App Check, admin claims, static delivery, and route/OpenAPI resolution.
- Node tests cover Memory V3 frontend behavior and secure voice token/reconnect behavior.

## Vercel prebuilt frontend deployment

- Removed Tailwind/esbuild execution from the Vercel build path.
- Added immutable frontend artifact manifest with source fingerprint and SHA-256 verification.
- Vercel now installs Python requirements explicitly and runs a standard-library frontend verifier.
- Added deployment regression tests preventing npm/Tailwind/esbuild from re-entering Vercel commands.
