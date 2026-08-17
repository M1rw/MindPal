# MindPal Voice provider research — 2026-08-17

## Active production model

MindPal’s backend default is `gemini-3.1-flash-live-preview` over the stable currently deployed `v1alpha` constrained ephemeral-token transport. The active model accepts text, images, audio, and video; returns text and audio; supports function calling, thinking, search grounding at the model-card level, and the Live API. It does **not** support code execution, structured output, URL context, or provider-native asynchronous function calling on this model. [1]

## Verified Live API capabilities that MindPal can use now

The model is designed for low-latency audio-to-audio dialogue. The Live API accepts 16 kHz PCM input and emits 24 kHz PCM output, supports input/output transcription, native audio, automatic or custom VAD, session resumption, context-window compression, `realtimeInput` text updates, and user barge-in. Gemini 3.1 can receive several content parts in one server event, so clients must process every audio/transcript part in the event. [1] [2]

Automatic VAD treats user activity as a barge-in and cancels model generation. A client should clear locally queued playback only after the corresponding interruption event. The API permits custom VAD using `activityStart` and `activityEnd`, enabling MindPal to own user-turn boundaries more deliberately rather than layering a competing local pseudo-turn detector on top of provider VAD. [2]

## Provider constraints that shape the redesign

Gemini 3.1 Live has **sequential** function calling; `behavior: NON_BLOCKING`, `WHEN_IDLE`, provider-native proactive audio, and affective dialog belong to Gemini 2.5 Live with v1beta and are not supported by the active model. MindPal’s previous Gemini 2.5/v1beta migration immediately closed production sessions, so those features remain deferred until separately proven in the production account. [1] [2]

The model card says search grounding is supported, but MindPal’s active raw Live setup currently declares only custom functions and does not attach a provider search-grounding tool. Freshness must therefore be enforced in the MindPal application layer: exact volatile-fact detection plus a verified backend search response before Voice can speak an answer. A model instruction alone is insufficient.

## Design implication

The recommended MindPal architecture is a five-layer state machine: **capture/VAD**, **turn ownership**, **conversation policy**, **verified tools and facts**, and **playback/session continuity**. It must pause silence timers while either party is active, avoid model-generated “are you still there?” injections during model playback, separately model listener presence from spoken backchannels, and gate volatile answers on evidence—not on function-call choice.

## References

[1] [Gemini 3.1 Flash Live Preview model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)

[2] [Gemini Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

[3] [Gemini Live API WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)

[4] [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api)

## Follow-up evidence: model and grounding boundary

The current Gemini 3.1 Flash Live model card explicitly lists function calling, search grounding, thinking, and Live API support. It also says Gemini 3.1 Live uses `realtimeInput` for post-setup text, can emit multiple audio/transcript parts in one server event, and does not support asynchronous function calling, proactive audio, or affective dialog. [5]

Google’s general Google Search grounding guide describes the current `google_search` built-in tool for the Interactions API, but its supported-model table does not list Gemini 3.1 Flash **Live**. That guide is therefore not sufficient proof that raw Gemini 3.1 Live WebSocket sessions accept a provider `googleSearch` tool in MindPal’s current ephemeral-token transport. MindPal should maintain its deterministic backend web-search gate until an isolated staging session proves the exact Live setup and response metadata. [6]

Google’s Enterprise Agent Platform overview recommends a newer GA `gemini-live-2.5-flash-native-audio` model for low-latency voice agents and lists affective dialog, proactive audio, VAD, and tool use. This is a different product surface from MindPal’s active Developer API model/transport and does not override the production failure previously observed with the older Gemini 2.5 preview migration. It is a separate compatibility evaluation, not an automatic production upgrade. [7]

## Additional references

[5] [Gemini 3.1 Flash Live Preview model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)

[6] [Google Search grounding documentation](https://ai.google.dev/gemini-api/docs/google-search)

[7] [Gemini Enterprise Agent Platform — Live API overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api)
