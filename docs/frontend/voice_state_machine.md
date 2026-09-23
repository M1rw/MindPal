# MindPal Voice State Machine

Purpose: keep browser voice predictable and debuggable.

There are two spoken paths:

- **Dictation** (shipped): `useChatInputDictation.ts` fills the composer. Its states are at the end of this file.
- **Live duplex call** (signed-in preview; `MINDPAL_VOICE_LIVE=0` disables): `frontend/src/voice/call/` talks to Gemini Live.

## Live duplex call

**Gemini runs the conversation.** Its own voice activity detection decides when the
caller starts and stops talking, and it reports barge-in as `serverContent.interrupted`.
The client never guesses at turn-taking: it sends every microphone frame, plays what
comes back, and reacts to Gemini's events. VAD settings live in the token mint
(`backend/domain/voice/token.py`, model `gemini-3.8-live`): start sensitivity HIGH (short replies like "no"
must register), end sensitivity LOW, 1500 ms of silence ends a turn.

Modules (`frontend/src/voice/call/`), each with one job:

| Module | Job |
|---|---|
| `callMachine.ts` | Pure reducer `(phase, event) -> { phase, effects }`. No timers, no I/O. |
| `callController.ts` | Wires transport events -> machine -> effects. The public `LiveVoiceSession`. |
| `transcript.ts` | Caption deltas, one finished turn per side, the full-call ledger. |
| `replyGuard.ts` | One nudge when Gemini chooses silence after a finished turn. |
| `safetyBridge.ts` | Transcript sync to the classifier and the model's `report_risk` tool. |
| `faceFeed.ts` | Energy, prosody, affect and listening reactions for the orb. Output only, never a sound. |
| `lifecycle.ts` | Clock, timers, reconnect helpers, page hooks. |
| `deps.ts` | Narrow ports to the outside world; `browserDeps()` wires the real ones. |

Phases:

```
idle -> connecting -> listening <-> userSpeaking -> waitingReply -> speaking -> listening
                          \_____________ dropped ______________/ -> reconnecting -> listening
any -> ended
```

- `listening -> userSpeaking` on caption words. Markers such as `<noise>` are not words.
- `userSpeaking -> waitingReply` after 1.2 s without new words: the turn becomes a
  transcript bubble, goes to the safety classifier, and the thinking dots show.
- `-> speaking` on MindPal's first audio. From `userSpeaking` this also closes the
  caller's turn, because Gemini only answers once it has decided they finished.
- `speaking -> userSpeaking` on `interrupted`: playback flushes at once, what MindPal
  already said stays in the transcript, and leftover audio of the cut reply is dropped
  for 450 ms. An interrupt with no words after it settles back to `listening`.
- `speaking -> listening` when playback drains and the provider has stopped sending.
- Words said over MindPal that did not interrupt it become a turn once it stops.

Opening: after `setupComplete` a single opener message (profile note with name, local
time and recent topics, or the chat thread) makes MindPal greet first. Mic PCM is held
by the transport until the greeting has finished playing, so its own echo cannot cut it
off. An empty greeting, or none within 7 s, is asked for once more.

Reply guard: a slow reply is never nudged, because a nudge on top of a real reply makes
MindPal answer twice. Only two cases get one nudge per turn: a generation that closes
empty (after 900 ms), or one that carries nothing but `<ctrl46>` for 1.5 s.

Lifetime: a dropped socket or `go_away` reconnects once per healthy setup, carrying a
short recap of recent words (or the resumption handle) and never greeting again. The
token is renewed 45 s before expiry. The call ends at the session limit, on device loss
after one retry, or when the server no longer knows the session.

Listening face (`face/listenerReaction.ts`): the visual "yeah". Timing comes from the
caller's voice, not words: speech of at least 0.9 s followed by a 220 ms pause is a phrase
ending in any language, and earns a nod (a double nod after 3.5 s of speech; at most one
per 1.3 s). Meaning comes from `POST /api/voice/reaction`: the words heard since the last
phrase go to a multilingual LLM that answers smile, surprise, concern, curious or none
(smiling eyes, a lifted "ah", soft concern, a curious look). No word lists anywhere. Only
concern shows while the caller is distressed; nothing reacts to MindPal's own voice; a
slow or failed classification just leaves the nod.

Speaking face: each sentence MindPal says is classified in `mindpal` mode (smile, laugh,
surprise, concern, tender, excited, curious, none) and its look is placed on the audio
timeline for the sentence's full spoken length. A neutral sentence carries the reply's
tone, softer; the tone lets go when the reply finishes playing. A fresh laugh or tender
moment also moves the head (a double bounce, a slow nod).

Face states (`thinking`, `reading` in the expression catalog, animated in `faceBlend.ts`):
`thinking` (eyes up and aside, slowly drifting) from the caller's pause to MindPal's
first sound; `reading` (eyes sweeping line by line) while a lookup runs. Reading wins
over thinking. Phrase timing for listening nods uses the raw frame level, not the
smoothed envelope, so ordinary 300 ms breaths between phrases register.

Lookups: the live model has `search_memory` and `search_past_chats` (NON_BLOCKING). The
browser relays each call to `POST /api/voice/recall` (`backend/domain/voice/recall.py`),
which checks the call is the caller's own and still open, and searches only their memory
graph or saved chats: language-neutral token and bigram matching with a recency boost,
short plain-text results, at most one lookup per 2 s and 20 per call. The answer goes
back to Gemini with `WHEN_IDLE`, so MindPal finishes its sentence and then uses it. A
failed lookup answers "nothing found"; a barge-in or new socket drops a late answer.
There is no web search, by product decision.

Testing: `tests/voice_call_harness.mjs` drives the real controller with a fake Gemini
socket, speaker, microphone and control plane on a virtual clock.
`tests/test_voice_call_scenarios.mjs` has one scenario per feature;
`tests/test_voice_call_units.mjs` covers every state/event pair and the small modules.

## Live duplex safety: who does what

The browser holds the only socket to Gemini Live; FastAPI never proxies PCM.

There is no crisis pause. A risky call stays open:
- **Support** (`stay_support`): a labeled note asks MindPal to slow down, stay present
  and offer 988 / 741741 without pushing them off the call. It is sent when MindPal is
  next idle, so it shapes the next reply instead of cutting the current one. Status
  shows "Still with you"; the face stays gentle.
- **Imminent** (`stay_support` with `imminent`, or a legacy `escalate_pause` /
  `speak_first`): the note naming immediate help goes out at once, once per call.
- The Live model's `report_risk` tool feeds the same path through a confirmation latch
  (`safety/riskRating.ts`). Neither path steps support back down within a call.
- Transcripts are classified at the end of every caller turn and on a heartbeat. A
  failed control-plane call resolves to `safety_unverified`: logged, never treated as
  `continue`, and never a reason to end the call. If the server has lost the session,
  the call ends rather than run unclassified.

Instructed by the server (`backend/domain/voice/session.py`):
- A Gemini JSON classifier (`backend/domain/safety/modes/voice/classify.py`) labels the
  transcript `not_crisis`, `distress_support` or `imminent_escalate` by meaning, in
  any language. There is no live-voice keyword list. Swearing, venting, jokes, dark
  humor, and asking for 911/988 are `not_crisis`. MindPal mentioning help numbers is
  not user intent.

Not enforced anywhere, on purpose:
- This is not clinical screening. It misses disclosures and can misread an ordinary
  conversation. Do not describe it as a guarantee, in code or in UI copy.
- `output_guard` is not wired into live voice: the audio has reached the ear before a
  transcript exists.
- `safetySettings` is sent on the token mint (`MINDPAL_VOICE_SAFETY_SETTINGS=0`
  disables it), with harassment, hate, sexual and dangerous-content at `BLOCK_NONE`
  so swearing and dark humor are not cut. A provider block never ends the call.
- Product call length is 30 minutes. After hangup, `POST /api/voice/summarize` writes a
  recap into chat history unless the call was in support.

## Dictation

States:
- idle
- confirming_language
- preparing_mic
- listening
- stopping
- review
- no_speech
- heard_no_transcript
- network_error
- permission_error
- device_error
- generic_error
- unsupported

Rules:
- Waveform is visual only. It must never decide that the user is speaking.
- No-speech, network, device, generic, and unsupported states are terminal.
- Retry is the only transition from terminal error states back to recording.
- Cancel always aborts recognition, stops the mic stream, closes the inline panel, and returns to idle.
- Accept only works when transcript text exists; it appends transcript to the input and returns to idle.
- Web Speech onend with transcript goes to review.
- Web Speech onend without transcript goes to no_speech or heard_no_transcript.
- No auto-retry and no hidden restart loops.
