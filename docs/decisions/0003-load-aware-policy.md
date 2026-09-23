# 0003: Non-essential work adapts to platform load; safety never does

**Status:** accepted, 2026-09-23

## Context

Traffic spikes and provider rate limits hit everything at once. Cosmetic and
deferrable work (face reactions, memory consolidation) competes with replies
people are waiting for.

## Decision

A shared per-minute pulse (active people, LLM calls, errors, rate limits,
latency) sets one of four levels: calm, busy, strained, critical. Each level
maps to a policy in `configs/json/dynamic.json` that scales memory
consolidation, voice face reactions, the chat history window and guest quotas.

Crisis detection and resources, the voice safety classifier and lease, and
signed-in users' quotas are exempt and never read the load level.

## Consequences

- Under pressure, guests lose capacity before signed-in people, and memory
  work waits for the scheduler.
- Capacity numbers are estimates to tune against real traffic.
- `MINDPAL_PRESSURE_OVERRIDE` pins a level during incidents.
