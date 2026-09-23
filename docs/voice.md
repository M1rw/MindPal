# Live Voice

Full-duplex calls with Gemini Live. The browser streams audio directly to
Gemini; the backend owns entitlement, quota, safety verification and privacy.
Live voice requires a signed-in account (dictation works for everyone).

## Call lifecycle

```mermaid
sequenceDiagram
    participant C as Browser call controller
    participant API as /api/voice/*
    participant S as VoiceSessionService
    participant G as Gemini Live

    C->>API: POST session-token (consent)
    API->>S: mint: account, flag, durable store,<br/>reserve seconds, learned style note
    S-->>C: ephemeral token + session id
    C->>G: connect with token (audio both ways)
    loop during the call
        C->>API: session-events (transcript sync, floor changes, heartbeats)
        API->>S: classify new caller speech, refresh safety lease
        S-->>C: ok / stay_support instruction
    end
    C->>API: session-events teardown
    S->>S: settle used seconds, refund the rest
    C->>API: POST summarize
    S-->>C: recap message in chat history (also becomes a memory digest)
```

## Quota

Accounts reserve up to the daily cap (30 minutes) when a call starts; teardown
settles on server-observed time and refunds the rest. A crashed tab is reclaimed
on the next mint rather than billed to the wall clock. Limits live in
`configs/json/voice_runtime.json`.

## Session states

`minted -> warm -> listening <-> speaking`, with `stay_support` layered on when
distress is verified, and `torn_down` at the end. Renewing the token requires a
fresh **safety lease**: a verified classifier verdict (or no caller speech yet)
within the stale window. A client that stops sending transcripts is treated as
unverified, not safe.

## Safety in calls

See [safety.md](safety.md#live-voice). In short: distress and even imminent risk
keep the call open with support-mode instructions; MindPal names immediate help
out loud. Two independent signals feed it: the server classifier on the
transcript, and the Live model's own risk rating.

## Components

| Area | Backend | Frontend |
|---|---|---|
| Session, quota, lease | `domain/voice/services/session.py`, `domain/voice/runtime/usage.py` | `voice/call/callController.ts`, `callMachine.ts` |
| Token and live prompt | `domain/voice/services/token.py`, `providers/gemini/` | `voice/control/geminiLive.ts` |
| Safety | `domain/safety/modes/voice/classify.py` | `voice/safety/` |
| Face and reactions | `domain/voice/services/reaction.py` (load-aware) | `voice/face/` |
| Recall during calls | `domain/voice/services/recall.py` | tool calls in `voice/call/` |
| Privacy, retention, analytics | `domain/voice/privacy.py`, `telemetry.py`, `analytics.py` | `voice/diagnostics/` (redacted traces) |

Retention runs daily from the scheduler (`/api/internal/voice-retention`).
Support can read redacted traces with the support credential only.
