# Voice V4 Layer 1 — Identity and Provider Credential Boundary

**Status:** Layer 1 implementation scope only. This specification authorizes no browser WebSocket, microphone capture, playback, UI activation, dynamic prompt behavior, feelings model, deployment, or production enablement.

## Responsibility

Layer 1 is the only boundary allowed to request a Google Gemini Live ephemeral token. It accepts a trusted authenticated MindPal request context, evaluates the existing `voice.live_v4` feature policy, applies a dedicated token-issuance rate limit, and requests a constrained short-lived token from Google. The permanent Gemini credential remains server-side.

Layer 1 returns a narrow token contract to the future browser session layer. It never proxies Live audio and never opens a browser or provider WebSocket.

## Authorization order

The endpoint must fail closed in this order:

1. Require a verified authenticated Firebase session.
2. Verify App Check when production settings require it.
3. Evaluate `voice.live_v4` using the server-owned feature registry and the trusted user/channel/locale context.
4. Apply the Layer 0 release gate. Production is denied by the Layer 0 production guard.
5. Consume the dedicated per-user and per-client token-issuance rate limit.
6. Confirm the server has a configured permanent Gemini key and a valid HTTPS provisioning endpoint.
7. Request a one-use token constrained to the fixed Live model, audio response modality, and session-resumption configuration.
8. Return only the short-lived token name, bounded expiry metadata, model, protocol version, and request ID.

The implementation must not call Google when any earlier condition fails.

## Token constraints

The provider request uses the server-side Gemini API key in an HTTP header, never in a URL or response. The request sets `uses: 1`, a short new-session start window, a bounded live-session expiry, and `liveConnectConstraints` that lock the model and audio response modality. The browser receives no permanent key, provider response body, or raw provider error.

## Safe response contract

```text
{
  token: string,
  expires_at_utc: ISO-8601 timestamp,
  new_session_expires_at_utc: ISO-8601 timestamp,
  model: "models/gemini-3.1-flash-live-preview",
  protocol_version: "v1beta",
  request_id: string
}
```

The token is held in browser memory by a later layer. Layer 1 does not persist it.

## Safe errors

The endpoint exposes only stable categories: `authentication_required`, `voice_feature_disabled`, `voice_release_not_approved`, `voice_rate_limited`, `voice_provider_not_configured`, `voice_provider_unavailable`, `voice_provider_timeout`, `voice_provider_invalid_response`, and `voice_configuration_invalid`. Provider bodies, API keys, Authorization headers, token values, and provider URLs are not included in errors or logs.

## Exit criteria

Layer 1 is complete only when unit and route tests prove authorization ordering, feature-policy enforcement, rate limiting, bounded expiry, exact provider request constraints, response redaction, timeout handling, invalid-provider-response handling, and no external call on denied requests. The full project audits must pass and the new Layer 1 module must contain no browser media or WebSocket code.
