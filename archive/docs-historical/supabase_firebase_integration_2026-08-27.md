# Firebase–Supabase Integration

## Decision

MindPal keeps **Firebase Auth** as its identity provider and keeps existing user memory, profile, and application data on Firestore. Supabase is an opt-in control plane for server-owned feature policies. This avoids a user-data migration while allowing PostgreSQL-backed policy storage and future reporting.

Supabase’s Firebase third-party Auth integration is enabled for the MindPal Firebase project. Firebase-issued JWTs can access Supabase only after the application supplies the required `role=authenticated` claim and the database has restrictive access policies. The service-side policy adapter does not trust client-provided admin state; MindPal continues to derive administrator access from the verified Firebase session claim.

## Data boundary

| Concern | Authority | Notes |
|---|---|---|
| User identity and administrator claim | Firebase Auth | The backend verifies Firebase sessions and reads the server-provided admin metadata. |
| Existing memory, profile, and safety data | Firestore | No migration is performed by this integration. |
| Feature-policy control plane | Firestore by default; Supabase when explicitly selected | `FEATURE_POLICY_STORAGE` is the only storage switch. Production must not be changed until Supabase credentials and verification are complete. |
| Raw Firebase UID | Not stored by the adapter | Feature targets use MindPal’s existing one-way `usr_` hash format. |

## Configuration

The backend accepts the following typed settings:

```text
SUPABASE_URL=https://ifezhzuwbdurxkpooblh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side secret>
FEATURE_POLICY_STORAGE=firestore
```

`SUPABASE_SERVICE_ROLE_KEY` is server-only. It must never be placed in frontend runtime configuration, source control, logs, browser storage, or chat. Keep `FEATURE_POLICY_STORAGE=firestore` until the service key is configured in the deployment environment and the Supabase-backed feature routes pass authenticated integration tests. An explicit `FEATURE_POLICY_STORAGE=supabase` selection fails startup if the URL or service key is missing; there is no silent fallback.

## Schema and concurrency

The `mindpal_feature_policies` table contains one `current` row with a monotonic revision and JSON policy document. Row-level security is enabled and direct access is revoked from anonymous and authenticated roles. The `mindpal_update_feature_policies` security-definer function is executable only by `service_role` and rejects stale revisions, preventing lost updates.

## Verification checklist

First verify that the table exists, RLS is enabled, the function has the expected arguments and return type, and the initial policy state is empty. Then configure the service key only in the backend deployment environment. Run the focused adapter tests and authenticated feature-admin tests. Confirm that Firestore remains the default for existing deployments. Finally verify that anonymous users cannot access feature-policy data and that the authenticated Firebase admin path can read and update the policy store.

No Voice microphone, provider token, or Google Live socket operation is part of this integration. Voice V4 remains independently controlled by its existing feature gate and production safety conditions.

## Reference

Supabase, **Firebase Auth: Use Firebase Auth with your Supabase project**, https://supabase.com/docs/guides/auth/third-party/firebase-auth
