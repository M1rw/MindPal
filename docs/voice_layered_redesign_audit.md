# MindPal Voice layered redesign audit

**Date:** 2026-08-17
**Scope:** Active production Voice on `gemini-3.1-flash-live-preview` with direct client-to-provider audio, ephemeral token issuance through FastAPI, and custom browser-executed tools.

## Executive finding

The poor conversation was produced by **four interacting system defects**, not simply a weak prompt. MindPal currently mixes local microphone activity, provider VAD, silence prompts, tool policy, playback state, and conversation style in one browser runtime. That lets the model receive contradictory cues and leaves factual freshness dependent on tool choice.

| Observed behavior | Root cause | Correct owner |
| --- | --- | --- |
| Generic disclaimer after everyday overwhelm | The Voice prompt does not define a strict boundary between ordinary emotional support, health guidance, and crisis escalation. Provider safety priors can fall back to generic disclaimers. | Conversation-policy layer |
| Generic, weak reply to a detailed business/distraction dilemma | A long system prompt says “be human,” but no turn-level policy extracts the actual bottleneck or prevents generic reflection-plus-vague-question replies. | Turn-understanding and response-policy layers |
| No spoken “yeah/mm-hm” during a long turn | The active Live model receives continuous audio but uses VAD-based turn processing; MindPal currently sends only a visual client cue and cannot guarantee semantic audio backchannels while the user is still speaking. | Attention layer plus provider-boundary policy |
| “Still with me?” after MindPal had just spoken | The local silence timer measures only user microphone activity. It does not pause for model playback, queued audio, model preparation, tool work, or pending response. It injects a new provider text turn while MindPal is speaking. | Session/turn-ownership layer |
| Old answer for New York mayor | Text chat has a deterministic officeholder/freshness gate; Voice relies on the live model to decide to call `web_search`. The active provider setup has custom tools only and no proven provider Google Search grounding. | Evidence and factual-integrity layer |

## Current active model and actual boundaries

MindPal uses `gemini-3.1-flash-live-preview`. It supports low-latency audio-to-audio interaction, function calling, thinking, input/output transcriptions, automatic or custom VAD, session resumption, and context-window compression. Gemini 3.1 may include multiple audio/transcript parts in one server event, so every part must be processed. [1] [2]

> The active model supports function calling but does **not** support provider-native asynchronous function calling, affective dialog, or proactive audio. Those features should not be claimed or configured on this production path. [1] [2]

The current browser runtime uses automatic VAD with `START_OF_ACTIVITY_INTERRUPTS`, which correctly enables user barge-in. The provider documents that interruption cancels model generation; client playback should then be cleared only when an interruption is observed. [2]

## Design: five explicit layers

| Layer | Responsibility | It must never do |
| --- | --- | --- |
| **1. Capture and VAD** | Stream microphone audio, maintain speech confidence, own visual listening state, and preserve barge-in. | Decide what the user means or send silence/health prompts. |
| **2. Turn ownership** | Decide whether the turn is user-speaking, yielding, model-thinking, model-speaking, or genuinely idle. Pause idle timers whenever either party or a tool is active. | Treat no microphone input as user abandonment while MindPal is speaking. |
| **3. Conversation policy** | Select a response move: listen, clarify, reflect, bottleneck-first coaching, factual verification, or crisis support. | Issue generic medical disclaimers for ordinary distress. |
| **4. Evidence and tools** | Enforce current-fact verification, execute only verified backend tools, associate results with the active topic, and refuse stale factual answers. | Fall back to memory for officeholders, prices, weather, scores, or elections. |
| **5. Playback and continuity** | Queue/fade playback, preserve full-duplex interruption, handle resumption/reconnect, and update transcript/UI. | Let an old response or old background result speak into a newer topic. |

## Design decisions

### Human response policy

MindPal will treat detailed personal dilemmas as **meaningful decision turns**, not generic “support” triggers. The first response must identify the concrete conflict, then make one useful move. For the reported case, the conflict is not “feeling overwhelmed” in isolation: it is *a money-building goal competing with unbounded social/dopamine commitments and no defined sales channel*. The assistant should reflect that insight briefly, make one priority distinction, and offer a next action or a precise fork—not a disclaimer or a vague “which would you like to focus on?”

Ordinary stress, overwhelm, indecision, frustration, or motivation problems receive normal human support. Health/medical caveats appear only when the person seeks diagnosis, treatment, medication, or actionable clinical advice. Crisis language is reserved for credible self-harm, imminent danger, or a request for emergency help.

### Listener presence

MindPal will not fake a constant “yeah” loop. The active model cannot guarantee semantic spoken backchannels during a single uninterrupted VAD-owned user turn. Instead, MindPal will provide a low-noise listening state while the user is speaking and make the post-yield opening sound responsive to the actual content. The prompt may permit one brief acknowledgement only when the provider genuinely begins a response; the application will not inject synthetic speech over the user.

### Silence ownership

The call-idle clock will run only during a verified **shared idle** state: microphone quiet, no user turn pending, no model audio queued/playing, no model generation/preparation, no tool call or verified research pending, and no reconnect. Model playback, tool work, and a pending answer reset or pause the idle clock. “Still with me?” is a last-resort call-state event, not a hidden model prompt that can collide with a reply.

### Verified current facts

For Voice, officeholders and other changing public facts must be application-gated. The current custom `web_search` declaration remains available, but model selection is not a security or accuracy control. A deterministic front-end/turn policy must mark volatile queries and prevent an answer from being played until a verified backend evidence result or a truthful verification failure returns. The unverified DuckDuckGo browser fallback must never satisfy that gate.

## Validation scenarios required before release

| Scenario | Expected result |
| --- | --- |
| Long personal dilemma | Specific reflection + one useful next move; no AI/medical disclaimer; no generic productivity list. |
| 45–90 seconds of user speech | No call close, no periodic fake spoken acknowledgements, visible active listening, and no silence prompt. |
| MindPal gives a 30+ second response | No “Still with me?” or call-end warning while audio is queued/playing. |
| User interrupts MindPal | Existing 120 ms fade applies; user speech owns the next turn; stale reply cannot resume. |
| “Who is the mayor of New York?” | Voice gives no answer from memory; it waits for verified current backend evidence or says it cannot verify. |
| Same question with search failure | No stale officeholder name; short transparent verification failure. |
| Explicit self-harm message | Existing direct safety response remains intact and does not get weakened by ordinary-support rules. |

## References

[1] [Gemini 3.1 Flash Live Preview model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)

[2] [Gemini Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

[3] [Gemini Live API WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
