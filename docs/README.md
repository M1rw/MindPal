# MindPal Documentation

| Doc | Read it for |
|---|---|
| [architecture.md](architecture.md) | System diagram, backend layers, the life of a chat turn |
| [memory.md](memory.md) | Facts, AI summary, self-learning, privacy controls |
| [voice.md](voice.md) | Live call lifecycle, quota, safety lease |
| [safety.md](safety.md) | Crisis handling in chat and voice |
| [operations.md](operations.md) | Deploy, configuration, storage, scheduled jobs, load levels |
| [development.md](development.md) | Setup, layout, tests, CI checks, conventions |

## Decisions

| # | Decision |
|---|---|
| [0001](decisions/0001-supabase-document-store.md) | Supabase is the production document store |
| [0002](decisions/0002-rationed-ai-memory.md) | AI memory is batched and rationed, never per turn |
| [0003](decisions/0003-load-aware-policy.md) | Non-essential work adapts to load; safety never does |
| [0004](decisions/0004-account-only-live-voice.md) | Live voice requires an account |

The API contract is `contracts/openapi.yaml`. Older design notes and audits are
preserved in the git tag `archive-2026-09`.
