# Memory Consolidation and Load-Aware Behaviour

## AI memory summary

MindPal keeps three layers of memory per signed-in account:

| Layer | Written by | Cost |
|---|---|---|
| Saved facts (`memory_graphs.atoms`) | Pattern extraction every turn | No AI |
| Conversation digests (`memory_journal.digests`) | One AI call per batch of turns; voice recaps reused for free | Rationed |
| Running summary (`memory_graphs.narrative`, `open_threads`) | One AI call merging previous summary + facts + digests | Rationed |

**Collect.** After each normal chat turn, a clipped (message, reply) pair is
journaled. Crisis turns and guests are never journaled.

**Compact.** When the journal reaches the turn threshold, or goes idle for 30
minutes with at least 2 turns, one json-model call writes a digest (<= 70
words: what they shared, how it felt, what helped). The raw turns are deleted;
only the digest is kept.

**Summarize.** When enough new digests or new facts accumulate, one call
rewrites the summary. A person's first consolidation also writes their first
summary, so new users don't wait. The summary goes into the chat prompt as
"Ongoing context", with up to 3 open threads to follow up gently.

**Rationing.** Thresholds, a per-person cooldown, a per-person daily AI budget,
and the platform load level (below). Typical cost: 2 calls for a person's
first ~6 turns, then about one call per 6-10 turns, never more than the daily
budget. There is no AI call on the reply path; inline work runs only after the
reply has streamed.

**Where it runs.** Inline after a reply when load allows, otherwise
`GET /api/internal/memory-consolidation` (scheduler credential). `vercel.json`
schedules it daily because Hobby plans allow only daily crons; on Pro, use
`*/15 * * * *`.

**People stay in control.** The memory screen labels an AI summary ("Written by
MindPal from your conversations"), shows open threads, and offers Refresh and
Forget. `GET /api/memory/journal` shows the digests. Deleting a fact drops the
AI summary and every digest mentioning it, then queues a rebuild. A summary the
person writes themselves is kept separate and never overwritten. Everything is
in account export and deletion.

**Safety.** Prompts forbid invention, diagnosis, clinical labels, and self-harm
method details. Crisis turns are excluded before compaction, and AI output
containing crisis language is rejected or neutralized.

## Platform pulse and load levels

Every instance counts active people (hashed), requests, LLM calls, failures,
rate limits, latency, and tokens per minute, and writes one small document per
instance per minute (`platform_pulse`). Readers merge the last 5 minutes across
instances (cached 20 s). This replaced one metrics document per LLM call.

Pressure is the busiest signal relative to capacity (`configs/json/dynamic.json`):
active people, LLM calls/min, error ratio, rate-limit ratio, latency.

| Level | Pressure | Memory AI | Face reactions | Chat history | Guest quota |
|---|---|---|---|---|---|
| calm | < 0.45 | eager, inline | normal | full | full |
| busy | < 0.75 | higher thresholds, inline | 1.6x slower | full | full |
| strained | < 0.95 | scheduler only, small batches | 3x slower | 80% | 60% |
| critical | >= 0.95 | paused (overdue jobs only) | off | 60% | 40% |

**Never load-dependent:** crisis detection and resources, the voice safety
classifier and its lease, and signed-in users' quotas.

**Operations:** `GET /api/internal/platform-pulse` (support credential) shows
the level and its drivers. `MINDPAL_PRESSURE_OVERRIDE=calm|busy|strained|critical`
pins the level during incidents.
