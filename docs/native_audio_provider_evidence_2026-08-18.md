# Native-audio provider evidence — 2026-08-18

## Verified provider availability

Google’s Firebase AI Logic Live API documentation states that both `gemini-2.5-flash-native-audio-preview-12-2025` and `gemini-3.1-flash-live-preview` are available on the Gemini Developer API free tier. This establishes that MindPal’s free API tier does not itself exclude access to the native-audio preview. Actual capacity is still governed by project-specific rate limits.

Source: [Firebase AI Logic — Gemini Live API](https://firebase.google.com/docs/ai-logic/live-api)

Google’s rate-limit documentation states that limits vary by model and project tier, can be restricted for preview models, and should be inspected in AI Studio. It explains that rate limits are tracked across RPM, TPM, and RPD, and are applied per project rather than per key.

Source: [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## Native-audio capabilities and constraints

Google’s Live API capability guide states that Gemini 2.5 Flash Live supports Proactive Audio and asynchronous `NON_BLOCKING` function calling, whereas Gemini 3.1 Flash Live does not. Proactive Audio requires `v1beta` and `proactivity.proactiveAudio: true`.

Source: [Gemini Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

The official native-audio model page identifies `gemini-2.5-flash-native-audio-preview-12-2025` as a Live API model with audio, video, and text inputs and audio/text outputs. The official raw WebSocket guide specifies the v1beta constrained endpoint with ephemeral tokens and requires the first message to be a setup message.

Sources: [Gemini 2.5 Flash Live Preview model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025) and [Live API raw WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)

## Known preview instability evidence

A Google `js-genai` issue reports clean close code `1007` shortly after the first microphone frame for this exact preview, with the provider reason `Cannot extract voices from a non-audio request.` The project issue was labeled as a Live API bug and confirms that a setup/model acceptance result alone does not establish usable browser session stability.

Source: [googleapis/js-genai issue #1189](https://github.com/googleapis/js-genai/issues/1189)

An independent March 2026 technical investigation reports `1008` closes after the first response when function calling was enabled on the same `preview-12-2025` model. It attributes the close to incomplete or unsupported function-calling behavior in the preview and reports improvement after switching to a `latest` alias. This is non-official corroboration, not a guarantee for MindPal’s account.

Source: [Native-audio function-calling disconnect investigation](https://zenn.dev/yudai_uk/articles/gemini-native-audio-function-calling-1008-fix?locale=en)

## MindPal production observations

MindPal’s native migration successfully received a v1beta ephemeral token, connected, completed setup, and produced an initial greeting. Fresh sessions then closed around 23–24 seconds. Removing provider function declarations and tool instructions did not restore sustained production connectivity. As of the last attempt, the UI still failed before a usable second user turn. A metadata-only authenticated `/api/voice/transport-diagnostic` endpoint is being added to collect the next provider WebSocket close code, reason, clean flag, setup/greeting state, duration, and model; it does not accept audio, transcript, prompt, or profile fields.

## Sources

1. [Firebase AI Logic — Gemini Live API](https://firebase.google.com/docs/ai-logic/live-api)
2. [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
3. [Gemini Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
4. [Gemini 2.5 Flash Live Preview model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025)
5. [Live API raw WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
6. [googleapis/js-genai issue #1189](https://github.com/googleapis/js-genai/issues/1189)
7. [Native-audio function-calling disconnect investigation](https://zenn.dev/yudai_uk/articles/gemini-native-audio-function-calling-1008-fix?locale=en)
