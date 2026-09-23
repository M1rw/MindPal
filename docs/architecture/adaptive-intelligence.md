# Adaptive Intelligence

How MindPal gets better for each person over time, and the limits on that.

## What it learns

A small per-account document (`adaptive_profiles/{user_id_hash}`), updated after
each successful chat turn from signals the person actually gives:

| Signal | Weight | Examples |
|---|---|---|
| Explicit requests | strong | "too long", "just listen", "be direct", "no lists", "انصحني" |
| Implicit style | light | message length, the language they write in |
| Reaction to the previous reply | per turn | "that helps", "you're not listening", "شكرا" |
| Thumbs up/down | strongest | `POST /api/chat/feedback` from the reply actions |

Reactions and thumbs reward or penalize the **strategy** that produced the reply
(Active Listen, Cognitive Tools, Guided Coach, Thorough) using a Beta-Bernoulli
estimate per strategy. All weights decay every turn, so the profile follows who
the person is now.

Lexicons and weights live in `backend/configs/json/adaptation.json`
(schema-validated at boot).

## How it is used

- **Strategy selection** (`backend/domain/chat/strategy.py`) scores every
  strategy from the message, in English and Arabic, and adds a learned bias.
  Clear messages follow the message. Ambiguous ones follow what has worked for
  this person. Distress is always held before it is coached.
- **Prompt note.** Confident preferences become a short note in the system
  prompt, marked as style-only with safety rules taking priority.
- **Personalization.** Learned length, tone, lists, and emoji preferences fill in
  settings the person has left at their defaults. Explicit settings always win.
- **Live voice.** The same note is sealed into the Live session instruction at
  mint time. It is only ever set server-side; a client-supplied value is
  dropped.

## Guarantees

- Crisis turns are never learned from, and learning never touches the safety
  path, crisis resources, or classifier behavior.
- Guests adapt within the current turn only. Nothing is stored without an account.
- People can see what was learned (`GET /api/user/adaptation`, Settings →
  Personalization → Learned preferences) and reset it
  (`DELETE /api/user/adaptation`). It is included in account export and deletion.
- Feedback sends no message text, only the rating and the strategy name.
- `MINDPAL_ADAPTIVE_LEARNING=0` switches learning off globally.

## Memory salience

Saved facts (`memory_graphs`) now track `mentions`, `first_seen`, and
`last_seen`. Salience = confidence × reinforcement (log of mentions) × recency
(45-day half-life), with identity facts pinned. When memory is full, the least
salient fact is evicted. Previously the list was truncated from the end, so new
facts about a long-time user were silently discarded. The model sees facts in
salience order. The auto-generated summary is refreshed on every merge and
is no longer sent alongside the facts it restates.
