# API Contract Matrix (Frontend ↔ Backend)

Every network call the web client makes, against the route that serves it.

The client lives in `frontend/src/services/api/`. Handlers live in
`backend/http/`, and `contracts/openapi.yaml` is the contract both sides are
checked against — `backend/http/wire.py` refuses to start if an operation in
`IMPLEMENTED` has no route behind it.

`frontend/js/` is the retired pre-TypeScript client. Nothing in it is current;
neither is `archive/frontend-legacy-*`.

## Access

Three tiers, and the line between them is what a route can reach:

- **Open** — reads no per-user storage. A guest gets a real answer.
- **Account** — reads or writes durable per-user state. Signed in or 401.
  There is no shared guest bucket to fall back to: an unauthenticated caller has
  an empty storage key, so there is nothing for these routes to address.
- **Guest-aware** — answers everyone, but a guest's answer is empty rather than
  somebody else's data.

A credential that is present but does not verify is a 401 on *every* tier,
including open ones. The client force-refreshes its ID token and retries once
(`frontend/src/services/api/http.ts`).

## Matrix

| Client | Method | Path | Operation | Access | Notes |
|---|---|---|---|---|---|
| `http.ts` (health) | `GET` | `/api/health` | `healthLive` | Open | |
| `http.ts` (health) | `GET` | `/api/health/ready` | `healthReady` | Open | |
| `index.ts` | `GET` | `/api/features` | `flagsSnapshot` | Open | Flat capability booleans, including `presence_enabled`. |
| `index.ts` | `GET` | `/api/release/changelog` | `releaseChangelogGet` | Open | |
| `index.ts` | `POST` | `/api/release/changelog` | `releaseChangelogDismiss` | Account | |
| `chat.ts` | `POST` | `/api/chat/stream` | `chatStream` | Guest-aware | Guests are rate-limited per network; accounts spend credits. Safety screens `message` **and** the recent user turns in `history`. |
| `chats.ts` | `GET` | `/api/chats` | `chatsList` | Account | |
| `chats.ts` | `POST` | `/api/chats` | `chatsSave` | Account | Message count and body size are clipped server-side. |
| `chats.ts` | `GET` | `/api/chats/{id}` | `chatsGet` | Account | 404 when the chat is not this account's. |
| `chats.ts` | `DELETE` | `/api/chats/{id}` | `chatsDelete` | Account | |
| — | `GET` | `/api/chats/current` | `sessionsGetCurrent` | Account | Legacy single-session. No current client caller. |
| — | `PUT` | `/api/chats/current` | `sessionsReplaceCurrent` | Account | Legacy. |
| — | `DELETE` | `/api/chats/current` | `sessionsDeleteCurrent` | Account | Legacy. |
| — | `POST` | `/api/chats/current/messages` | `sessionsAppendMessages` | Account | Legacy. |
| — | `POST` | `/api/sessions/telemetry` | `sessionsRecordTelemetry` | Account | No client caller. Per-turn telemetry rides the authenticated chat stream instead. |
| `users.ts` | `GET` | `/api/user/me` | `identityMe` | Open | Identity only; reads nothing stored. A guest's `user_id_hash` is empty. |
| `users.ts` | `GET` | `/api/user/profile` | `identityGetProfile` | Account | |
| `users.ts` | `PATCH` | `/api/user/profile` | `identityPatchProfile` | Account | `settings` is a bounded flat map of scalars. |
| `users.ts` | `GET` | `/api/user/insights` | `identityGetInsights` | Account | Counts stored user turns. No invented clinical scores. |
| `users.ts` | `GET` | `/api/user/wellness-timeline` | `identityGetWellnessTimeline` | Account | |
| `users.ts` | `GET` | `/api/user/export` | `identityExport` | Account | |
| `users.ts` | `DELETE` | `/api/user/data` | `identityDeleteData` | Account | |
| `memory.ts` | `GET` | `/api/memory/graph` | `memoryGetGraph` | Guest-aware | A guest gets an empty graph; their facts stay on the device. |
| `memory.ts` | `PUT` | `/api/memory/graph` | `memoryPutGraph` | Account | Atoms are clipped and capped exactly as the chat merge path does. |
| `memory.ts` | `PATCH` | `/api/memory/graph/items/{id}` | `memoryPatchGraphItem` | Account | |
| `memory.ts` | `DELETE` | `/api/memory/graph/items/{id}` | `memoryDeleteGraphItem` | Account | |
| `memory.ts` | `GET` | `/api/memory/summary` | `memoryGetSummary` | Guest-aware | |
| `memory.ts` | `POST` | `/api/memory/summary/refresh` | `memoryRefreshSummary` | Account | Body optional. With none, the summary is rebuilt from saved atoms — deterministic, not a model call. |
| `voice.ts` | `GET` | `/api/voice/usage` | `voiceGetUsage` | Account | Read-only; never reserves. |
| `voice.ts` | `POST` | `/api/voice/session-token` | `voiceCreateSessionToken` | Account | Holds the reservation in one transaction. |
| `voice.ts` | `POST` | `/api/voice/session-events` | `voiceRecordSessionEvent` | Account | |
| `voice.ts` | `POST` | `/api/voice/summarize` | `voiceSummarizeSession` | Account | |
| — | `POST` | `/api/voice/reaction` | `voiceClassifyReaction` | Account | Silent face reaction for a phrase; answers `none` when rate limited. |
| — | `POST` | `/api/voice/recall` | `voiceRecall` | Account + own call | Memory / past-chat lookup for the live model; guests get nothing found. |
| — | `GET` | `/api/greeting` | `greetingGet` | Account | No current client caller; `useGreeting` falls back locally for guests. |
| — | `GET` | `/api/system/route-catalog` | `systemRouteCatalog` | Account | Internal surface map. Not public. |

## Routes with no client caller

`sessionsGetCurrent`, `sessionsReplaceCurrent`, `sessionsDeleteCurrent`,
`sessionsAppendMessages`, `sessionsRecordTelemetry`, `greetingGet`, `chatsGet`,
`systemRouteCatalog`, `voiceClassifyReaction`, `voiceRecall`.

These are live and authenticated, not stubs. They are listed so the gap is a
decision someone makes rather than something nobody noticed.

## Client methods with no current caller

`getUserMe`, `getUserProfile`, `patchUserProfile`, `getChatSession`, and the
health helpers are exported from `frontend/src/services/api/` but nothing calls
them. Settings still live in `localStorage`; there is no cloud personalization
sync yet, so the profile round trip exists on both sides without being wired.

## Ordering note

`/api/chats/current` is registered **before** `/api/chats/{session_id}` in
`backend/http/sessions.py`. FastAPI matches in registration order, so the
parameterized route would otherwise swallow `current` as a session id and the
four legacy handlers would be unreachable. Keep that order.
