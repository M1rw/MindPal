# MindPal Feature Management System

**Status:** Design baseline for implementation

**Scope:** All user-visible MindPal capabilities and server-side capability gates, including future features.

## Goal

MindPal needs one authoritative, extensible feature-management system rather than scattered environment flags, hard-coded hidden buttons, and user-profile booleans. The system must let operators release a capability globally, to a controlled audience, or to selected users; show an honest lifecycle label in the interface; and fail closed for risky or unavailable capabilities without leaking policy details or private user data.

The system is intentionally separate from ordinary user preferences. A user preference answers “what does this user prefer?” A feature policy answers “is this capability available to this user in this deployment?” The frontend receives an evaluated snapshot for the current session, while the backend evaluates the same policy server-side for every protected operation.

## Core vocabulary

| Concept | Meaning |
|---|---|
| Feature key | Stable namespaced identifier such as `chat.pro_model`, `memory.cloud_sync`, or `voice.live_v4`. Keys are never renamed casually; deprecations use aliases or migrations. |
| Lifecycle | Product state shown to users: `active`, `beta`, `preview`, `maintenance`, `disabled`, or `deprecated`. Lifecycle does not by itself grant access. |
| Availability | Evaluated result for the current request: `enabled`, `disabled`, or `restricted`. It is derived from policy, identity, rollout, environment, and safety constraints. |
| Policy | Server-owned rule set for a feature. It contains default access, lifecycle metadata, target rules, percentage rollout, schedule, and optional prerequisites. |
| Target rule | A deterministic predicate over trusted request context, such as authenticated status, admin claim, channel, locale, or a hashed user identifier. Raw IDs are never returned in snapshots or logs. |
| Override | A higher-priority explicit decision for one stable user hash or a named segment. Overrides are server/admin managed, never accepted from the browser. |
| Segment | A reusable named audience definition. Segments are optional in the first implementation but the policy schema reserves the boundary so future rules do not become ad-hoc fields. |
| Snapshot | A safe response containing only feature metadata and the evaluated result for the current session. It is cacheable only for the request/session lifetime and must not expose targeting rules or secrets. |

## Lifecycle states

The lifecycle is metadata and presentation. Access is still evaluated independently.

| Lifecycle | Intended meaning | Default access behavior |
|---|---|---|
| `active` | Stable feature supported for normal users. | Follow configured access policy. |
| `beta` | Feature is usable but still under validation. | Follow configured policy; show a Beta badge and short disclosure. |
| `preview` | Early opt-in or limited preview. | Deny by default unless a target rule grants access. |
| `maintenance` | Temporarily unavailable while the feature is repaired or upgraded. | Deny all non-admin access; show maintenance state and safe fallback. |
| `disabled` | Deliberately turned off or not ready. | Deny all access; show “Disabled for now” where the feature has a visible entry point. |
| `deprecated` | Supported only temporarily and scheduled for removal. | Follow configured policy, but show a deprecation notice and replacement when available. |

Safety-critical functions are not user-disableable. A policy may hide or disable an optional clinical presentation, but it must not disable deterministic crisis handling, output safety guards, authentication checks, audit redaction, or quota/rate-limit enforcement.

## Evaluation precedence

The backend evaluates policies in a fixed order so an accidental broad rollout cannot override an emergency shutdown:

1. Unknown key: return disabled with `unknown_feature` internally and a generic unavailable result externally.
2. Hard safety/platform kill switch: return disabled. This is reserved for operators and infrastructure, not user preferences.
3. Expired or future schedule: return disabled until the policy window is active.
4. Lifecycle `maintenance`, `disabled`, or `deprecated` rules that explicitly deny access: return disabled.
5. Explicit user override: apply the stored allow/deny decision for the trusted user hash.
6. Target rules and prerequisites: evaluate against verified request context.
7. Percentage rollout: use a stable hash of `feature_key + user_id_hash` so a user does not move between cohorts on every request. Unauthenticated users use a non-persistent session-safe bucket and must not receive user-targeted rollouts.
8. Default access: apply only when no narrower rule made a decision.

For a denied result, the client receives a stable reason class such as `disabled`, `maintenance`, `preview_only`, `not_in_rollout`, or `requires_authentication`; it never receives raw predicates, user lists, internal notes, or provider errors.

## Policy shape

Policies are server-owned documents keyed by feature key in a dedicated collection. A normalized policy has this conceptual shape:

```text
FeaturePolicy {
  key: string
  version: integer
  lifecycle: active | beta | preview | maintenance | disabled | deprecated
  title: string
  description: string
  user_visible: boolean
  default_enabled: boolean
  requires_authentication: boolean
  allowed_channels: string[]
  allowed_locales: string[]
  rollout_percentage: 0..100
  allow_admins: boolean
  allow_user_hashes: string[]
  deny_user_hashes: string[]
  prerequisites: string[]
  starts_at_utc: timestamp | null
  ends_at_utc: timestamp | null
  fallback_key: string | null
  replacement_key: string | null
  updated_at_utc: timestamp
  updated_by: string
}
```

The stored document is validated and bounded before persistence. User hashes are derived server-side from verified identity and are never accepted as raw Firebase UIDs. Policy documents are not stored inside `preferences.ui_settings`, because that field is user-owned, size-limited, and unsuitable for global control or auditability.

## Initial registry

The first registry should cover existing visible and server-relevant capability boundaries without pretending every button is an independent product feature.

| Feature key | Surface | Initial lifecycle | Safe default |
|---|---|---:|---:|
| `chat.standard_model` | Standard chat model | `active` | Enabled when a provider is configured. |
| `chat.pro_model` | Pro/clinical reasoning mode | `active` | Enabled only when the existing provider/quota path is available. |
| `chat.listening_styles` | Active Listen, Guided Coach, Cognitive Tools | `active` | Enabled; individual modes can later become separate keys. |
| `memory.local` | Local memory | `active` | Enabled unless the user turns memory off. |
| `memory.cloud_sync` | Cloud profile, memory, and chat sync | `active` | Enabled only for authenticated users and configured auth/database. |
| `mental_health.insights` | PHQ-9, GAD-7, presenting problems, treatment display | `beta` | Disabled until its backend data path is available; no fabricated data. |
| `data.export` | Conversation export | `active` | Enabled locally. |
| `data.product_improvement` | Anonymized product-quality signals | `preview` | User opt-in only; never raw message content. |
| `notifications.response_complete` | Background response notification | `beta` | Follow the existing preference and browser capability. |
| `notifications.streak_reminders` | Streak reminder | `beta` | Off by default. |
| `notifications.mood_check_in` | Mood check-in | `beta` | Off by default. |
| `security.crisis_interception` | Local crisis interception UI | `active` | Enabled and not user-disableable in a way that weakens safety. |
| `brain.workspace` | Brain/memory workspace | `beta` | Disabled if its page/data dependencies are unavailable. |
| `voice.live_v4` | Future full-duplex Voice V4 | `disabled` | Must remain absent/inactive until separately approved and gated. |

The registry should be the only place where a new feature receives its key, copy, lifecycle, default, and safety classification. Code may still enforce provider-specific conditions, but it must not invent a second policy system.

## API contract

The first backend API should expose:

- `GET /api/features`: returns the evaluated snapshot for the current session. Anonymous access is allowed only when the deployment allows anonymous sessions. The response contains key, title, description, lifecycle, enabled, reason class, user-visible status, fallback/replacement metadata, and a registry version.
- `GET /api/admin/features`: requires the existing verified `mindpal_admin=true` claim. Returns policy metadata and aggregate targeting information, not raw user identifiers.
- `PUT /api/admin/features/{feature_key}`: validates and replaces one policy using optimistic versioning. Requires an explicit expected version to prevent lost updates.
- `POST /api/admin/features/{feature_key}/actions`: supports safe named operations such as enable, disable, start maintenance, set beta, and restore previous version. Every mutation writes a redacted audit event.

Every backend route that performs a feature-protected operation must evaluate the feature using the current trusted session, not trust a frontend snapshot. A stale or missing snapshot may hide a control, but it can never grant server access.

## Frontend contract

The browser gets a small feature client with three responsibilities:

1. Load and normalize the evaluated snapshot after application bootstrap and after authentication changes.
2. Answer `isFeatureEnabled(key)` and `getFeatureState(key)` synchronously from the latest snapshot with safe disabled defaults.
3. Render lifecycle badges and disabled/maintenance explanations consistently, while preserving keyboard access and clear fallback actions.

Feature checks belong at the entry point of a capability and at the action boundary. For example, the model selector should hide or disable Pro when `chat.pro_model` is unavailable, and the chat request path should still rely on the backend denial if a stale client attempts to submit Pro. A feature entry point must never silently disappear when a useful explanation or fallback can be shown.

User preferences remain in `settings_store.js`. They may express opt-in choices such as notification channel, memory preference, or product-improvement consent, but they cannot override server policy. The feature snapshot must not be persisted as authoritative state in localStorage; a short-lived cache may be used only as an offline hint and must be invalidated when identity changes.

## Administration and governance

The settings surface should have two different experiences. Normal users see capability cards or badges only when a feature is relevant: Beta, Preview, Maintenance, Disabled for now, or Deprecated. They do not see targeting rules, user hashes, rollout percentages, or internal notes. Administrators receive a protected Feature management panel showing status, lifecycle, rollout percentage, schedule, prerequisites, recent version, and an explicit impact warning before saving.

Administrative operations should follow a release workflow: draft policy, validate, preview evaluated audience counts, publish with a version bump, monitor safe aggregate telemetry, and roll back through the previous version. The first implementation may provide publish and rollback without a separate draft store, but the API should use versioned documents so a future change log can be added without changing feature consumers.

## Security and privacy rules

Feature policy evaluation must not log raw bearer tokens, Firebase UIDs, email addresses, user messages, transcripts, microphone/audio content, or provider response bodies. Logs may contain feature key, policy version, result class, request ID, and a one-way user-hash prefix only when operationally necessary. Admin responses must not return full allow/deny lists. The browser must never receive secret provider configuration or an unredacted policy document.

A feature control is not a substitute for authorization. Admin endpoints use the existing verified Firebase custom claim path. User self-service endpoints continue to rebind all writes to the authenticated session. Any request that fails closed because the feature store is unavailable must return a safe, stable error and leave existing user data untouched.

## Failure and rollout behavior

If the feature store is unavailable, built-in registry defaults apply only for features explicitly marked safe-by-default. Risky, preview, maintenance, and future features default to disabled. If the snapshot request fails, the client uses the same safe defaults, marks the snapshot as stale, and does not enable a feature that was not already active in the static registry. If identity changes, the client discards the previous evaluated snapshot before loading the new one to prevent cross-user access leakage.

A feature cannot be removed from the registry while active policy documents reference it. Deprecated keys remain evaluable until their consumers are removed. Every policy update is validated against prerequisites and fallback cycles; fallback chains must terminate and must not point to a disabled feature without an explicit user-visible explanation.

## Implementation sequence

The safest delivery is staged:

1. Add the pure policy model, registry, evaluator, bounded validation, and deterministic tests. No UI behavior changes yet.
2. Add the read-only `GET /api/features` snapshot and a frontend feature client with safe defaults.
3. Integrate only the existing model selector, cloud sync, notifications, mental-health panel, brain workspace, and data controls. Keep Voice V4 disabled and do not add Voice runtime code.
4. Add admin read/write routes, optimistic versioning, redacted audit events, and an admin-only management panel.
5. Exercise anonymous, authenticated, admin, targeted, rollout, maintenance, stale-snapshot, missing-store, and rollback paths in tests and a real browser preview before any deployment.

This preserves current behavior for stable existing features while creating one controlled release boundary for future capabilities.
