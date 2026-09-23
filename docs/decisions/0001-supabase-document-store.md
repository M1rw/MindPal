# 0001: Supabase is the production document store

**Status:** accepted, 2026-09-23

## Context

All application data goes through one `DocumentStore` interface
(collection, document ID, JSON data) with Firestore, Supabase and in-memory
implementations. The Firebase project `mindpal-official-0` is used for sign-in
but has **no Firestore database**: every Firestore call returns `NotFound`.
Before the Supabase provider existed, the old store detected that and silently
ran on per-instance memory, so production data was neither durable nor shared.

Pointing production at Firestore (PR #161) made every account request return
503 until PR #162 reverted it.

## Decision

- Production uses Supabase (`mindpal_documents`, with conflict-checked writes
  via `mindpal_update_document`).
- When `MINDPAL_STORAGE_PROVIDER` is unset, Supabase is preferred over
  Firestore. Firebase credentials exist for sign-in and are not evidence that a
  Firestore database exists.
- A durable provider is never silently replaced with memory.

## Consequences

- Firestore stays a supported, tested provider. Switching needs a Firestore
  database created first, then `scripts/ops/migrate_store.py`.
- Supabase migrations are part of deploys (`supabase/migrations/`).
