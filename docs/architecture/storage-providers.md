# Storage Providers

MindPal keeps identity (Firebase Auth, including Google sign-in) separate from
application data storage. Both durable providers implement the same
`DocumentStore` contract (`backend/infra/store/shared.py`), so every feature
works unchanged on either.

## Choosing a provider

`MINDPAL_STORAGE_PROVIDER` selects the store:

| Value | Store | Use |
|---|---|---|
| `firestore` | Cloud Firestore via the shared Firebase Admin app | Production default. Existing accounts' data lives here. |
| `supabase` | Postgres `mindpal_documents` via PostgREST | Alternative durable store. Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. |
| `memory` | Per-process dict | Tests and local work only. |

When unset, the backend picks `firestore` if Firebase Admin credentials exist,
otherwise `supabase` if configured, otherwise `memory` (logged as an error when
`ENVIRONMENT=production`). An unknown value fails startup.

## Failure behaviour (both durable providers)

- **No silent downgrade.** A durable provider that is unreachable at boot stays
  in place, degraded. It is never swapped for memory: that turned a shared
  database into per-instance state, reset quotas and lost chats.
- **Half-open circuit breaker.** After 3 failures the provider stops calling
  the backend for 30 s, then probes again and recovers on its own.
- **Reads** may be served from a bounded cache while degraded (a stale read
  beats an outage). A document deleted in the cloud is never resurrected from
  the cache.
- **Writes fail closed.** They raise `StoreUnavailable`; nothing that enforces a
  limit (chat credits, voice minutes) trusts per-instance memory. Live voice
  refuses to start without a durable store in production.
- **Replace semantics.** `set_document` replaces the whole document on every
  provider, so a removed key really disappears.
- **Health.** `/api/health/ready` returns 503 while degraded; startup logs it
  without crashing the deployment.

## Per-user operations

Account export, account deletion, voice analytics, and retention use
`query_documents(collection, "user_id_hash", …)` and id-prefix listings with the
documents' real ids. They never scan other accounts' rows. Supabase listings
page past PostgREST's row cap, and `LIKE` prefixes are escaped so `_` is not a
wildcard.

## Supabase setup

1. Apply `supabase/migrations/0004_mindpal_documents.sql` and
   `0005_mindpal_documents_no_phantom_rows.sql` (0005 stops a rejected write
   from leaving an empty row behind and adds the per-user index).
2. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as server-side
   secrets only. The service-role key must never reach the browser.

## Moving data between providers

```
python scripts/migrate_store.py --from firestore --to supabase --dry-run
python scripts/migrate_store.py --from firestore --to supabase
```

The copy keeps document ids, is idempotent, and verifies per-collection counts.
Switch `MINDPAL_STORAGE_PROVIDER` only after the copy verifies.
