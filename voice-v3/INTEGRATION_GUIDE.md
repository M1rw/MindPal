# MindPal Voice V3 Integration Guide

MindPal Voice V3 is an isolated TypeScript engine under `voice-v3/`. Voice V2 remains the production default until the V3 integration has been validated in a staging deployment. The recommended rollout is to mount V3 behind a feature flag, verify authentication, microphone permissions, Gemini voice-name setup, native cue behavior, captions, interruption behavior, and telemetry, and only then switch the product entry point.

## 1. Add the integration files

During the isolated phase, the V3 package can be consumed directly from the repository. In the MindPal V2 React build, either publish `voice-v3` as an internal package or copy the contents of `voice-v3/src/integration/` together with the V3 `src/core/`, `src/layers/`, and `src/app.ts` modules. Do not copy the debug dashboard into the production route unless it is protected behind a development-only flag.

A production component imports the hook as follows:

```tsx
import { useVoiceV3 } from "./voice-v3/integration/use-voice-v3";

export function LiveVoicePanel() {
  const voice = useVoiceV3({
    baseUrl: "",
    getAuthToken: async () => firebaseAuth.currentUser?.getIdToken() ?? null,
    getAppCheckToken: async () => {
      const result = await getToken(firebaseAppCheck, false);
      return result.token;
    },
    voicePersona: "Kore",
    voiceEmotion: "neutral",
    autoStart: false,
    startCapture: true,
  });

  return (
    <section aria-label="Live voice">
      <button onClick={() => void voice.start()} disabled={voice.isRunning}>
        Start voice
      </button>
      <button onClick={() => void voice.stop()} disabled={!voice.isRunning}>
        Stop
      </button>
      <button onClick={voice.isMuted ? voice.unmute : voice.mute}>
        {voice.isMuted ? "Unmute microphone" : "Mute microphone"}
      </button>
      {voice.activeCaption && <p dir="auto">{voice.activeCaption}</p>}
      {voice.errorMessage && <p role="alert">{voice.errorMessage}</p>}
    </section>
  );
}
```

The hook creates `VoiceV3App` inside `useEffect`, subscribes to LayerLink snapshots, batches high-frequency updates in a microtask plus React transition, and disposes capture, transport, subscriptions, and telemetry on unmount. The start button should be triggered by a real user gesture so browsers permit the Web Audio context to resume.

## 2. Authentication and token acquisition

`RealTokenProvider` calls `GET /api/voice/token` and sends the current Firebase ID token as `Authorization: Bearer <token>`. It also sends `X-Firebase-AppCheck` when the App Check callback returns a token. The provider caches a token until it has less than 30 seconds remaining, retries transient failures, honors `Retry-After`, and does not retry HTTP 429 indefinitely. Refresh callbacks can be supplied when the auth or App Check token has expired.

The token endpoint response must contain `token`, `model`, `websocket_url`, `expires_at`, and `new_session_expires_at`. Expiry values may be epoch seconds, epoch milliseconds, or ISO timestamps. The V3 browser code never sends audio or transcript data to the token endpoint.

## 3. Gemini-native backchannel and thinking cues

V3 uses Gemini Native Audio as the sole production voice source. The Live setup sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` with the selected Gemini prebuilt voice name, normally `Kore` or `Charon`. Normal assistant responses and approved short cues therefore use the same Gemini session and the same persona voice; no CAMB ID, external TTS request, local voice model, or synthetic audio is required for the production path.

The `BackchannelConductor` remains responsible for policy rather than audio generation. It observes RMS continuity, natural pauses, main-lane playback, cooldowns, rolling-window limits, final transcripts, and turn completion. When a cue is eligible, it emits a `gemini-native` intent. The composition root sends a bounded `realtimeInput.text` value in the form `VOICE_CUE_REQUEST: <cue>`, and Gemini returns the short acknowledgement through its configured Native Audio voice. The application generation-fences that response, routes its audio to the backchannel lane, and does not treat its transcript as a normal assistant caption turn.

The setup instruction constrains the response to one short acknowledgement such as `mhm`, `yeah`, `I hear you`, or `go on`; it must not answer the user’s topic or start a second full response. The same instruction also asks Gemini to produce a brief natural thinking phrase before a tool/search operation when appropriate, such as `Let me check that for you`, followed by the tool operation. The application still cancels or fences output on barge-in and turn completion.

The existing `RealtimeTTSProvider`, `/api/voice/v3/tts` endpoint, static assets, and synthetic cue provider remain available only as explicit lower-level compatibility/test seams. The default V3 composition root never constructs or contacts them. A cue is not approved merely because a provider can synthesize audio; it must satisfy the conductor’s pause, playback, cooldown, and identity rules.

## 4. Gemini persona configuration and live review

Gemini persona identity is configured in the Live setup payload, not through CAMB or another external voice catalog. The supported review names are the Gemini prebuilt voice names `Kore` and `Charon`. The transport sends the selected name exactly as `voiceName`; it does not synthesize or infer a provider-specific ID.

The internal `/voice-v3-review` page starts an authenticated real Gemini Live session for either persona. The reviewer can request the common cue set (`mhm`, `yeah`, `aha`, `right`, and `okay`) through the active session, listen to the returned Native Audio, and record pass/fail/unsure comments. The review is a live conversational test, not a one-shot external TTS sample test, because the final product path is stateful Gemini Live audio.

No credentials are embedded in the frontend. The existing token endpoint continues to issue the short-lived Gemini Live token, and the selected persona is only a non-secret prebuilt voice name. Human review must verify that each cue sounds like the same persona as the main assistant response and that the cue does not become a full answer or a duplicate caption.

## 5. Production feature flags and launch gate

V3 is controlled by five flags: `VOICE_V3_ENABLED`, `VOICE_V3_VERBAL_CUES_ENABLED`, `VOICE_V3_PROSODY_CONTEXT_ENABLED`, `VOICE_V3_MEMORY_ENABLED`, and `VOICE_V3_CLARIFICATION_ENABLED`. They can be supplied through Vite `VITE_` variables, a runtime `__MINDPAL_VOICE_V3_FLAGS__` object, or explicit user/session overrides. Session overrides take precedence over user overrides, which take precedence over environment values. When `VOICE_V3_ENABLED=false`, the hook does not create a V3 app and the existing V2 integration remains responsible for voice. Disabling verbal cues selects the non-verbal provider; disabling prosody context prevents any context note from reaching Gemini.

The backend mirrors the flags as typed settings and supports deterministic rollout through `VOICE_V3_ROLLOUT_PERCENT` plus user/session overrides. The launch gate should validate that every enabled persona is an allowed Gemini prebuilt voice name and that the token/setup path is reachable; it must not require CAMB IDs or an external TTS cache warm. A failed Gemini gate disables V3 for that launch without crashing the service or blocking V2.

Required production settings are:

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
# No CAMB voice IDs are required for Gemini Native Audio.
```

Enable `VOICE_V3_ENABLED` only after the Gemini token/setup path is reachable, the selected Gemini voice names are accepted by the target model, native cue requests remain short and fenced, and human review confirms each persona’s main response and cue audio. A failed gate must disable V3, not substitute another voice source.

## 6. Local prosody and emotional context

Sprint 11 analyzes scalar capture RMS, locally measured speech/pause timing, partial transcript timing metadata, interruption events, session noise floor, and mute state inside `ProsodyAnalyzer`. It never sends microphone audio, PCM, or an external emotion request. The output is a conservative `ProsodyState` with energy, speech-rate, pause-pattern, an explicitly labeled emotional guess, confidence, and monotonic change time.

The analyzer applies a confidence threshold and a 1.5-second hysteresis window. Loudness alone cannot produce `angry`, and quietness alone cannot produce `sad`; those labels require additional timing/interruption evidence and sufficient confidence. The UI should present `emotionalGuess` as a bounded assistive signal, not as a diagnosis or a fact about the user.

When a turn finalizes, or when a high-confidence state changes, the analyzer may publish a short context note such as `User sounds urgent. Respond concisely and calmly.` The composition root sends that sanitized note through the active-session Gemini Live `realtimeInput.text` path. It does not use `clientContent`/`send_client_content` for mid-session updates; Google’s official Live API capabilities guide documents `send_client_content` as an initial-history mechanism and directs active text updates to `send_realtime_input` [1]. Gemini 3.1 receives only this controlled application note; no undocumented provider emotion field is sent.

Backchannel adaptation maps excited speech to attentive cues, frustrated/angry speech to calm acknowledgements, sad/quiet speech to soft or reduced cues, urgent speech to concise cues with a shorter cooldown, and hesitant speech to a longer pause tolerance. Playback reduces backchannel gain for sad/quiet states and applies a faster fade when an urgent main response begins. Frustrated/angry cues require a stronger natural-pause signal before approval.

## 7. Static backchannel assets

Place the three small mono WAV files at these public paths in the Vite application:

```text
voice-v3/public/assets/cues/mhm.wav
voice-v3/public/assets/cues/yeah.wav
voice-v3/public/assets/cues/aha.wav
```

When copied into MindPal V2, use the equivalent public directory that is served at the site root:

```text
frontend/assets/voice-cues/mhm.wav
frontend/assets/voice-cues/yeah.wav
frontend/assets/voice-cues/aha.wav
```

If that V2 directory is mapped to a different URL, pass `assetBasePath` to `StaticAssetCueProvider`. The fallback provider fetches each asset once, decodes it through the resumed `AudioContext`, verifies mono 24 kHz audio, caches the decoded buffers, and returns them synchronously during later cue decisions. It does not fetch or decode on every pause. If any asset is missing or malformed, it clears partial caches and falls back to `SyntheticCueProvider` without repeated network work. Real production verbal cues should use the realtime TTS path above; treat static and synthetic cues as controlled fallback modes.

For bandwidth, keep cues short and trim leading/trailing silence. WAV is the safest source for deterministic PCM conversion. OGG or MP3 may be used when the browser’s decode support is verified for the target device, but the decoded result must still be converted or scheduled as mono 24 kHz audio. Do not place large media libraries in the Vite public directory.

## 8. Production mode and rollout

Use `providerMode: "real"` with a `RealTokenProvider` in production. `PRODUCTION_MODE` defaults to Vite’s production build flag, while an explicit `productionMode` option can be used by a staging harness. The mock transport and explicit prebuilt-audio compatibility path remain available for local deterministic tests; the default app uses Gemini-native cue intents even in the real-mode composition root.

The first staging pass should use a feature flag and record the following operational checks: authenticated token success, WebSocket setup completion, exact Gemini `voiceName` setup, AudioContext resume after the user gesture, microphone permission handling, native cue request/response behavior, persona/voice matching, cue-response generation fencing, discard on resumed speech, approval at the natural-pause boundary, PCM playback at 24 kHz, caption release after scheduled playback, barge-in flush, reconnect behavior, and telemetry POST status. CAMB/TTS endpoint checks are not part of the Gemini-only launch gate.

## 9. Legacy external-cue compatibility

The injected local model and `RealtimeTTSProvider` are retained only for isolated regression tests or an explicitly approved legacy experiment. They are not part of the Gemini-only production path, are not constructed by the default `VoiceV3App`, and must not be used to claim that Gemini persona identity has been reviewed. Any future external-cue experiment must remain behind a separate flag and must prove that it cannot mix voices with the active Gemini session.

## 10. Telemetry privacy checklist

`TelemetrySink` sends only counters and bounded diagnostic codes using the backend field names `model`, `audio_parts`, `input_transcription_events`, `output_transcription_events`, `transcript_callback_events`, `model_text_parts`, `turn_complete_events`, `interrupted_events`, `fact_gated_audio_parts`, and `end_reason`. It batches every ten seconds and uses `keepalive: true` on the final session flush.

The sink must never read or serialize microphone samples, PCM buffers, base64 audio, user speech, assistant transcript text, captions, prompt content, or provider response content. State-transition names, stale-event counts, playback underruns, queue-depth aggregates, caption drift aggregates, and sanitized error codes are retained locally for diagnostics; only the backend’s approved numeric counters and end reason are posted. Auth and App Check headers are attached when callbacks provide them. Telemetry failure must not stop the voice session.

## 11. Recovery messages

The hook maps common failures to product-safe messages: microphone permission failures become `Microphone permission denied.`, a recovery state becomes `Connection lost, reconnecting…`, and other connection failures become `Voice could not connect. Please check your connection and try again.` Raw provider errors should be logged only through the application’s protected diagnostics path, not shown in the user caption surface.

## 12. Sprint 15 local voice memory

Sprint 15 adds an opt-in, browser-local memory layer. `LocalMemoryStore` uses IndexedDB when available and a bounded in-memory fallback for test environments. Each user record is keyed by the caller-provided `memoryUserId` and is bounded to 20 key facts and 20 preferences; inserting beyond a limit evicts the oldest entry. The store contains no provider credentials and is never sent as telemetry.

`MemoryExtractor` is deterministic and local-only. It recognizes only explicit statements such as `My name is …`, `I work at …`, `I am building …`, `I prefer …`, and `I don't like …`. It rejects hedged or ambiguous language, writes only normalized facts/preferences, and builds a setup context containing at most five facts and five preferences, capped at 500 characters. Before a realtime socket opens, `WebSocketTransportManager` awaits this context and, when non-empty, adds it as `setup.systemInstruction.parts[0].text`.

Memory is fully gated by `VOICE_V3_MEMORY_ENABLED`. A session without a `memoryUserId`, or a session created with `incognito: true`, does not read, inject, or write memory. The debug panel exposes bounded counts, the last injected context, extraction count, and a clear-memory action for internal testing. The production V2 path remains independent of this layer.

A production integration may opt in as follows:

```tsx
const voice = useVoiceV3({
  memoryUserId: currentUser.uid,
  incognito: false,
  featureFlags: { VOICE_V3_MEMORY_ENABLED: true },
});
```

Do not pass raw transcripts to analytics or external extraction services. If a product requires deletion beyond the local record, it must explicitly clear the browser storage for the relevant user and verify that the session is stopped before changing identity.

## 13. Internal human voice review

The isolated V3 entrypoint serves `/voice-v3-review` as a review-only page. It starts an authenticated Gemini Live session with the selected prebuilt voice name, requests the common cue set (`mhm`, `yeah`, `aha`, `right`, and `okay`) through `realtimeInput.text`, plays the returned 24 kHz Native Audio through the normal backchannel lane, records pass/fail/unsure comments, and exports a JSON review artifact.

The review page is not a rollout control. A `GO` result requires successful Gemini setup for both selected persona names, scheduled native cue responses, and a pass for every cue; any failed or missing cue remains `PENDING`/`NO-GO`. Save exported artifacts under `artifacts/voice-persona-review/`, which is ignored by Git.

## 14. Validation

From the isolated workspace, run:

```bash
cd voice-v3
npm run check
npm test -- --run
npm run build
cd ..
pytest -q
python3 -m py_compile backend/api/voice_router.py
```

The build must include the cue files under `dist/assets/cues/` or an equivalent public-root path. Verify the generated asset names and perform one authenticated staging session before enabling V3 for general users.

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Google Gemini Live API capabilities guide"
