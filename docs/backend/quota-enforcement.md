# Quota Enforcement — Backend

Server-side credit limits for `POST /api/chat/stream`.
Enforced in `ChatOrchestrator.preflight_turn` via `backend/domain/quota/quota.py`.

## Credit System

| Reply mode | Credit cost | Provider model | Prompt |
|------------|-------------|----------------|--------|
| Standard | 1 | `gemini-2.5-flash` (gateway default) | Situation-based (listen / cognitive / coach) |
| Pro | 2 | Same Gemini chat model | Thorough: more complete replies. Not clinical, not 2× compute. |

Crisis / safety-override turns do not consume credits. The composer picker must describe this split, not a larger model.

## Signed-in windows

| Window | Limit | Reset |
|--------|-------|-------|
| 5-hour | 50 credits | 5 hours after the window opens |
| 1-week | 500 credits | 7 days after the window opens |

Keyed by the verified account id. Refunds on disconnect, cancel, empty output, or provider error.

## Anonymous traffic

Guests are **not** billed against `usr_anon_default` (that key is not a user quota subject). Unauthenticated chat uses a **stricter per-network rate limit** keyed by the TCP peer the server accepted (`request.client.host`, hashed). Client headers (`X-Forwarded-For`, device ids, graph ids) are not consume keys.

| Window | Limit |
|--------|-------|
| 5-hour | 10 credits |
| 1-week | 40 credits |

Same Standard=1 / Pro=2 costs, crisis still free, refunds still apply. The stream `usage` object reports these limits with `scope: "network"`.

**Tradeoff:** guests on one public IP (NAT, campus, CGNAT) share one bucket; a client with many IPs can multiply allowance. This is the conservative production choice versus minting a signed guest session (cookie/token, CSRF, rotation). Deploy behind a reverse proxy must enable trusted proxy headers so `request.client.host` is the connecting client, not the load balancer. Without that, guests share the proxy address — still not a global `usr_anon_default` user bucket.

## Enforcement Flow

```
1. Classify safety. Crisis replies skip quota and skip the provider.
2. Reserve credits for the selected model (standard=1, pro=2).
   Signed-in → account windows. Guest → hashed peer rate limit.
3. If either window would exceed its limit → HTTP 429 quota_exceeded.
4. Stream the provider reply. Refund on disconnect, cancel, empty output, or provider error.
5. Emit a usage object on the SSE stream after a successful reserve.
```

## Stream Metadata

Successful non-crisis streams include a `usage` object:

```json
{
  "credits_5h": 12,
  "limit_5h": 50,
  "reset_5h_seconds": 14400,
  "credits_week": 45,
  "limit_week": 500,
  "reset_week_seconds": 504000,
  "scope": "account"
}
```

Guest streams use the anonymous limits and `"scope": "network"`. The client usage store reads this from the stream. There is no separate fake meter.
