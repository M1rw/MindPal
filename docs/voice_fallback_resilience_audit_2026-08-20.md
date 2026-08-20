# MindPal Voice Fallback Resilience Audit

**Date:** 20 August 2026
**Repository:** `M1rw/MindPal`
**Primary production default:** `gemini-2.5-flash-live-preview`
**Fallback default:** `gemini-2.5-flash-live-preview`

## Executive conclusion

The Gemini fallback implementation is correct and resilient for **ephemeral-token provisioning failures**. When the configured primary is Gemini 3.1 and token provisioning fails, the backend tries Gemini 2.5 exactly once, returns the model actually issued, and returns the matching v1beta WebSocket URL. When the primary succeeds, the fallback is not probed. When primary and fallback are identical, the candidate is attempted once rather than duplicated.

Quota and idempotency accounting are also safe at the token boundary. One request reserves quota once. A successful primary or fallback commits once and completes idempotency once. A dual failure refunds once and fails idempotency once. No partial token response is returned.

The fallback now covers two bounded startup failures. Token provisioning still falls back server-side before the session starts. In addition, when a Gemini 3.1 token is issued but the provider fails before setup completes, the browser can consume a short-lived, signed, one-use fallback grant and request a Gemini 2.5-only credential. V2 rebuilds the returned model’s setup and backchannel capability metadata before replacing the failed startup socket. The grant is not available after the conversation becomes ready, is attempted once, and is never used for an established-session close. This prevents model switching from corrupting transcript continuity or creating a recovery loop.

## Effective model hierarchy

| Situation | Candidate order | API version |
|---|---|---|
| Default production configuration | Gemini 2.5 Live | v1beta |
| Explicit `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview` and successful provisioning | Gemini 3.1 only | v1alpha |
| Explicit Gemini 3.1 primary fails provisioning | Gemini 3.1, then Gemini 2.5 Live | v1alpha, then v1beta |
| Native Audio explicit override | Native Audio only unless configured fallback is distinct | v1beta |
| Primary and fallback are the same string | One candidate only | Determined once from that model |
| Both candidates fail | No credentials; HTTP 502; quota refund | N/A |

The backend sanitizes both configured model names, removes a duplicate fallback candidate, and computes the API version separately for each candidate. The frontend receives `model` and `websocket_url` from the backend and builds its setup from the returned model, so a successful 3.1-to-2.5 fallback is not mislabeled as 3.1.

## Request flow

```text
Authenticated browser
    │ GET /api/voice/token
    ▼
Rate limit + idempotency claim + one quota reservation
    │
    ├─ Try configured primary with model-specific API version
    │     ├─ success → commit once, complete idempotency, return model + URL
    │     └─ failure → try configured fallback if distinct
    │
    ├─ Try fallback with its own model-specific API version
    │     ├─ success → commit once, complete idempotency, return fallback model + URL
    │     └─ failure → refund once, fail idempotency, return HTTP 502
    ▼
Browser builds Gemini setup from returned model and connects directly
```

The browser’s `fetchVoiceTokenWithRetry()` is a separate network retry layer. It refreshes authentication/App Check for 401/403 and retries transient token-route failures according to its bounded attempt count. It does not select a model itself; model selection remains server-controlled.

## Failure-case verification

A new adversarial suite, `tests/test_voice_fallback_resilience.py`, covers five cases:

| Case | Observed result |
|---|---|
| Primary Gemini 3.1 succeeds | One v1alpha call; no fallback call; quota commit exactly once. |
| Primary Gemini 3.1 fails | One v1alpha attempt, then one Gemini 2.5 v1beta attempt; returned model is 2.5. |
| Primary and fallback strings are identical | One attempt only; no duplicate provider call. |
| Both candidates fail | HTTP 502; one quota refund; no commit; idempotency failure recorded once. |
| Native Audio is the fallback | Fallback receives v1beta and returned URL is v1beta constrained transport. |

The adversarial fallback suite now contains **7 tests**, including signed-grant issuance, fallback-only reuse without a second quota reservation, and invalid-grant rejection. Existing backend voice-security tests and frontend startup/recovery tests continue to pass, and the full repository suites pass after the generated frontend bundle is rebuilt.

## Accounting and security review

The fallback loop is inside one quota reservation. It does not reserve separately per model, so a primary failure followed by a fallback success consumes one session unit rather than two. The success path commits the reservation only after a non-empty ephemeral token is returned. The dual-failure paths call refund exactly once; the quota service’s state transition is idempotent for already-refunded records.

The idempotency claim is created before provider calls and is completed only after a usable token and selected model are available. Failure deletes the in-flight claim, allowing a future request with a new request ID to try again. A completed token request is not replayed by the endpoint; this prevents accidental reuse of a one-use ephemeral credential.

The fallback model is not accepted from arbitrary client input. It is configured server-side through `GEMINI_LIVE_FALLBACK_MODEL`, and the token response exposes only the selected model and constrained WebSocket URL. The permanent Gemini API key never enters the browser response or WebSocket URL.

## Error-resilience boundary

The current implementation handles errors in the following order:

1. **Primary token provisioning failure:** try the configured fallback exactly once when distinct.
2. **Fallback token provisioning failure:** refund the single reservation, fail the idempotency claim, and return a controlled 502.
3. **Browser token-fetch network/auth failure:** bounded client retry; refresh auth/App Check on authentication failures; never multiply a 429 because of `Retry-After`.
4. **Post-token WebSocket close after setup:** the recovery supervisor attempts resumption and then reseeding with bounded attempts, preserving handles and transcript continuity. It does not change models after readiness.
5. **Post-token model setup rejection before readiness:** V2 suppresses the normal startup-ready rejection long enough for the recovery supervisor to consume the signed grant once, fetch a fallback-only Gemini 2.5 token without a second quota reservation, update model-dependent capabilities, and replace the failed socket. If that attempt fails, the ready gate rejects immediately and the session ends cleanly.

The remaining limitation is intentional: this fallback is only for the pre-conversation startup window. It cannot and should not switch an already-established conversation from Gemini 3.1 to Gemini 2.5. A mid-session change would require a new continuity contract and could alter voice, turn ownership, and transcript semantics.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api "Gemini Live API documentation"
[2]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens "Gemini Live API ephemeral tokens"
