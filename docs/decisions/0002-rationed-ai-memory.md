# 0002: AI memory is batched and rationed, never per turn

**Status:** accepted, 2026-09-23

## Context

An AI-written summary of each person makes MindPal feel like it remembers. A
model call on every turn would roughly double cost and add latency to replies.

## Decision

Conversations are journaled and compacted into digests in batches (about 6+
turns, or after 30 idle minutes); the running summary is rewritten only when
enough new digests or facts accumulate. Calls are limited by thresholds, a
per-person cooldown and daily budget, and platform load. Voice recaps are
reused as digests at no cost. No AI call is ever on the reply path.

## Consequences

- A person's summary lags their latest conversation by up to a batch.
- Typical cost: 2 calls for the first ~6 turns (first digest and first
  summary), then about one call per 6-10 turns.
- Raw journaled turns are deleted after compaction (data minimization).
