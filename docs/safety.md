# Safety

MindPal is a wellness companion, not a crisis line, clinician or emergency
service. Safety behavior is never adjusted by platform load or learned style.

## Text chat

```mermaid
flowchart TD
    M[New message] --> C{Crisis language?<br/>message + 2 recent user turns}
    C -- yes --> R[Crisis resources response<br/>988 call/text, 741741, local emergency]
    C -- no --> G[Normal turn]
    G --> OG[Output guard on streamed reply]
    R --> X[No model call, no memory, no learning]
```

- Detection: normalized English and Arabic patterns with benign-idiom
  exclusions (`domain/safety/modes/chat/classify.py`, `configs/json/safety.json`).
  Recent history is re-screened so a disclosure can't be hidden one turn back.
- The output guard drops any streamed token that would complete companion-breaking
  boilerplate such as "as an AI language model"
  (`domain/safety/shared/output_guard.py`, patterns in `configs/json/safety.json`).
- Crisis turns are excluded from memory extraction, the conversation journal,
  AI summaries and the adaptive profile.

## Live voice

```mermaid
flowchart LR
    S[Caller speech] --> T[Transcript sync<br/>to server]
    T --> K[Classifier<br/>not_crisis / distress_support / imminent_escalate]
    S --> L[Live model risk rating<br/>report_risk tool, 0-10]
    K -- distress or imminent --> ST[stay_support<br/>call stays open]
    L -- 7+ confirmed twice --> ST
    ST --> H[MindPal slows down, stays,<br/>names 988 / 741741 / local emergency]
    H --> P{Caller asks for numbers or text,<br/>immediate physical danger,<br/>or audio fails}
    P -- yes --> PZ[Paused screen with dialable<br/>resources + continue in text]
```

- The classifier reads meaning, not keywords, and tolerates imperfect model
  output. An unparseable or unavailable verdict is **unverified**, never "safe",
  and the safety lease then blocks renewal.
- The Live model's rating is a second signal, because it hears tone and pauses
  that transcripts lose. It is not treated as proof of safety.
- MindPal's own words (including offering 988) never count as caller risk.

## Guarantees and limits

- Crisis detection, resources, the voice classifier and its lease are exempt
  from load shedding.
- Nothing ends a call on the caller because of risk.
- Detection is not clinical screening and does not catch every crisis. The UI
  says so where resources are shown.

Tests: `tests/backend/voice/test_voice_crisis_classifier.py`,
`test_voice_safety_*`, `tests/frontend/test_voice_crisis_enforcement.mjs`,
`test_voice_distress_safety_contracts.mjs`.
