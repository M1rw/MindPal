# MindPal Voice and Tools Audit

**Author:** Manus AI  
**Scope:** Live Voice, browser and backend TTS, live-tool execution, memory/chat retrieval, time/date, web search, data retention, and communication-mode parity.  
**Audit status:** Code review, focused security and contract tests, full regression/build verification, and an authenticated production startup check completed on 17 August 2026.

## Executive assessment

MindPal has a credible live-voice foundation. The production system uses authenticated, one-use ephemeral Live API tokens, App Check-aware token refresh, per-user quotas and rate limits, PCM audio streaming, output/input transcription, interruption handling, reconnect logic, and server-side execution for voice tools. The production application was also observed reaching the **Listening** state through an authenticated browser session.

The audit found four defects that could materially reduce reliability, privacy clarity, or response quality. They were remediated in this release: the live transport used the wrong post-setup text envelope for the configured Gemini Live model; the selected MindPal model/mode was not passed to Voice; tool calls discarded the browser’s timezone; and untrusted profile, memory, and chat data entered the live system prompt without an explicit data-only boundary. The privacy switch wording was also corrected to describe its actual scope.

> The live provider documents that Gemini 3.1 Flash Live expects post-setup text updates through realtime input, while client content is for seeding initial history. It also documents that audio input/output transcriptions are configured separately and that the response language is inferred rather than directly configured. [1]

| Overall area | Assessment | Release status |
|---|---|---|
| Voice startup and credentials | Strong controls: authentication, App Check, one-use ephemeral tokens, expiry, quotas, and no-store response headers. | Verified by regression tests and production startup. |
| Voice conversation quality | Previously generic and mode-agnostic. Live Voice now receives a concise HRO response contract for the selected mode and Pro provenance rule. | Improved and covered by regression tests. |
| Provider protocol compliance | Post-setup greeting, silence, and recovery prompts previously used the incorrect envelope for the configured live model. | Fixed. |
| Tool correctness | Voice REST tool calls previously forced the timezone to UTC. | Fixed with validated IANA timezone propagation. |
| Prompt/data boundary | Saved profile, memory, recent chat, and transcripts were usable as context without an explicit untrusted-data guard. | Fixed with ordered system instructions and bounded context labels. |
| Privacy UX | The eye toggle implied a broader "incognito" promise than it implemented. | Copy and accessibility semantics corrected. |
| Residual privacy risk | Normal voice calls still persist raw transcripts into chat, memory extraction, and cloud sync by design. | Product decision still required. |
| Web search reliability | Free DuckDuckGo HTML/Instant Answer/Lite cascade is vulnerable to provider changes and can return no current-news answer. | Follow-up hardening recommended. |

## Architecture mapped during the audit

The live flow begins in the browser overlay. Once a signed-in user starts Voice, the browser acquires microphone access, requests a short-lived session token from `POST /api/voice/token`, opens the provider WebSocket with that token, sends 16 kHz PCM frames, and receives 24 kHz audio plus live input/output transcripts. The browser handles VAD-related state, barge-in, silence, reconnects, and audio playback.

The backend owns token minting, request authentication, App Check validation where enabled, idempotency, quota reservation/refund, and rate limiting. The same authenticated tool gateway is used by Voice and text chat. It exposes seven server-side tools: `get_user_profile`, `search_memory`, `get_recent_chat`, `search_chat_history`, `current_time`, `date_calculator`, and `web_search`.

| Component | Responsibility | Audit conclusion |
|---|---|---|
| `backend/api/voice_router.py` | Live-token provisioning; transcription and call-summary endpoints. | Token protections are appropriate; voice tool context itself is not used for time queries. |
| `frontend/js/voice/runtime.js` | Microphone capture, PCM conversion, WebSocket lifecycle, prompt setup, tools, VAD, playback, barge-in, and recovery. | Core runtime is capable; received protocol and prompt-boundary fixes. |
| `frontend/js/voice_live.js` | Overlay controls, captions, transcript collection, call stop, and post-call sync decision. | Privacy control scope is now accurately stated. |
| `backend/api/tools_router.py` | Authenticated tool execution, request validation, per-user rate limits, and tool context. | Timezone propagation corrected. |
| `backend/tools/*.py` | Memory, chat, time/date, and web-search tool implementations. | Tools are bounded and server-side; search resiliency is the primary remaining weakness. |
| `backend/services/tts_service.py` | External TTS/provider fallback policy. | Clear safety policy and browser fallback semantics; actual external-provider health must remain operationally monitored. |

## Remediations completed in this release

### 1. Correct live text transport

MindPal used `clientContent` for runtime greeting, silence checks, and recovery prompts. The configured `gemini-3.1-flash-live-preview` model accepts `clientContent` only when seeding initial context history; later text needs `realtimeInput.text`. This mismatch could cause greeting/silence/recovery behavior to be rejected or inconsistent. The runtime now sends post-setup text via `realtimeInput.text` and has a regression test that prohibits a future reversal. [1]

### 2. Bring live Voice under the selected HRO communication style

Voice previously built a generic conversational prompt regardless of whether the user selected Active Listen, Guided Coach, Cognitive Tools, Standard, or Pro. The context provider now passes the canonical selector state to Voice. The live prompt adds the following concise contract:

| Mode | Live Voice behavior now required |
|---|---|
| Active Listen | Respond precisely to the actual point; avoid mechanical restatement; use one grounded question only when helpful. |
| Guided Coach | Diagnose the bottleneck with a short concrete fork before advice; reject generic checklists while the constraint is unknown. |
| Cognitive Tools | Separate observation from hypothesis and avoid diagnoses. |
| Pro | Keep user statements separate from assistant interpretations; never recast an inference as user history. |
| Standard | Use a natural grounded response without a fixed template, while retaining universal safety and language rules. |

### 3. Preserve local time for tools

The frontend already has access to the browser’s IANA timezone, and the backend already validates it. However, the REST tool router constructed all tool contexts with `UTC`, producing potentially wrong answers for local time, dates, deadlines, and date calculations. The request context now retains the validated timezone and the standard API client plus Voice tool executor send `X-MindPal-Timezone`.

### 4. Create a real prompt/data boundary

Voice used saved profile data, memory lines, recent chat, and recent transcripts to make conversations continuous. That material is user-authored and may contain adversarial or instruction-like text. The prompt now establishes safety instructions *before* any such data and labels profile, memory, chat, and turns as **untrusted data only**. Values are bounded; profile fields are JSON-quoted and control characters are removed before the runtime uses them in context.

### 5. Make privacy control truthful

The Voice eye control prevents the completed call from being added to chat, memory extraction, and cloud-chat persistence. It does not prevent authenticated live processing while the session is active. The prior message, "Call won’t be saved," could reasonably be interpreted more broadly. The control now says **"Call won’t be added to chat"**, has matching tooltip and ARIA state, and the implementation documents its exact scope.

## Residual risks and recommended next work

| Priority | Finding | Impact | Recommended next action |
|---|---|---|---|
| P0 product decision | By default, normal calls preserve full user and assistant transcripts in local chat, run memory extraction on the user transcript, and sync the resulting voice record. | Voice often contains more sensitive disclosures than text. A general privacy promise can be misunderstood. | Offer an explicit **Save transcript** choice at call end, or make transcript saving opt-in; retain a short summary only when the user chooses it. Update Privacy Policy to name the processing path clearly. |
| P1 architecture | Live audio travels directly between the browser and the Live provider after the ephemeral token is issued. Therefore it does not receive the backend’s full post-generation response-quality evaluator or server safety pipeline. | The prompt now carries HRO principles, but it is not the same deterministic enforcement level as text chat. | Design a server-mediated or transcript-gated voice safety/quality layer for high-risk sessions; do not silently claim identical guarantees until it is in place. |
| P1 reliability | `web_search` relies on free DuckDuckGo HTML, Instant Answer, and Lite parsing, including regex parsing of markup. Historical production conversations showed repeated failure to retrieve current-news answers. | Current-events answers may degrade into repetitive fallback language or unsourced claims. | Use a maintained search/news provider with source metadata, recency, citations, health checks, and a safe graceful-degradation message. |
| P1 UX | The browser can start Voice successfully, but this audit did not synthesize a spoken test phrase through the user’s microphone. | Full turn-level latency, barge-in quality, Arabic output quality, and tool-call timing remain production observability items. | Add opt-in synthetic/browser test coverage, instrument startup-to-first-audio and tool-call latency, and conduct a controlled Arabic/Egyptian-Arabic voice QA script. |
| P2 safety | Existing live prompt handles self-harm with a direct safety question, but live Voice relies heavily on provider behavior and prompt adherence. | A quality regression could be more consequential in a spoken, emotionally charged setting. | Add an explicit high-risk voice session state with immediate local-emergency/nearby-person guidance, clear escalation copy, and verified transcript review rules. |
| P2 TTS operations | `TTSService` has a safe browser fallback and external-provider policy, but actual configured provider availability is operational state. | Browser voices can vary significantly by device and may not match expected quality. | Monitor `/api/tts/health` internally, define an external-provider SLO, and expose a non-sensitive client capability/fallback indicator. |

## Validation evidence

The complete validation suite passed after the remediation set.

| Validation group | Result |
|---|---:|
| Backend response, API, chat, voice security, and timezone tests | **96 passed** |
| Frontend recovery, voice startup, voice summary, and new voice-contract tests | **27 passed** |
| Frontend build and immutable prebuilt-asset verification | **Passed** |
| Authenticated production Voice startup | **Passed**; the overlay reached **Listening** and was then manually ended without a spoken test. |

The live platform is currently documented by Google as **Preview**, so capability changes and compatibility monitoring should be treated as normal operational work rather than a one-time integration task. Official guidance also notes that Arabic (Egyptian) is supported and language is chosen by the model from the interaction; MindPal’s same-language system instruction is therefore the correct mechanism to reinforce Egyptian Arabic behavior. [1] [2]

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini API — Live API capabilities guide"
[2]: https://firebase.google.com/docs/ai-logic/live-api/configuration "Firebase — Configuration options for the Live API"
