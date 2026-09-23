# 0004: Live voice requires an account

**Status:** accepted, 2026-09-23

## Context

A guest path for live voice was added without the rest of the call being
available to guests: session events, which carry the transcript to the safety
classifier, require an account. Guests also shared one quota bucket, and the
open token endpoint let anyone start paid Gemini Live sessions.

## Decision

Minting a live voice session requires a signed-in account. Dictation remains
available to everyone.

## Consequences

- Every live call has server-side crisis classification and an enforced quota.
- Offering guest voice later needs a server-derived guest identity, a guest
  quota, and guest access to session events. It's not just a flag.
