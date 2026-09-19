# Mental health tab

Settings → Mental health shows a **reflection of the person’s own words**, not screening scores.

MindPal is a wellness companion. This tab is not a diagnosis, not PHQ-9/GAD-7, and not live clinical monitoring.

## Data sources

| Viewer | Source | Endpoint / path |
|---|---|---|
| Signed-in | Account memory graph + synced chat user turns | `GET /api/user/wellness-timeline` (401 if signed out) |
| Guest | This-device guest facts + local chat history | Client `reflectWellnessFromDevice` — nothing is invented from the cloud |

The client does not call the signed-in API as a guest. A 401 is handled as signed-out and falls back to this-device reflection — not “Couldn't load”. Empty account memory is an empty state. Real 5xx stays an error.

Delete (`DELETE /api/user/data`) removes the server graph and synced chats this reflection is derived from.

## What the UI shows

| Surface | When |
|---|---|
| Disclaimer | Always |
| Crisis resources (988 / 111 / findahelpline.com) | Always |
| Mood over time | Coarse **heavier / mixed / lighter** bars from dated user turns that used mood language |
| Heavier / lighter day | Only when the API (or local reflection) returns them — enough dated signal, not a single offhand word |
| Themes | Recurring topics (sleep, work, relationship, …) with mention counts and a short “from your words” snippet |
| Life events | Explicit events (moved, new job, breakup, …) and a date if a chat turn around then mentioned them |
| Empty | Honest copy; guests also get a sign-in CTA |
| Crisis language | A quiet note. Those turns are **not** charted |

## What this is not

- Not PHQ-9, GAD-7, or 0–100 happiness
- Not a suicidality sparkline
- Not a therapist report generated in the client
- Streaks stay a calendar count of days you sent a message
