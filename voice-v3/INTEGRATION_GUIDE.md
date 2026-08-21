# MindPal Voice V3 Integration Guide

MindPal Voice V3 is an isolated TypeScript engine under `voice-v3/`. Voice V2 remains the production default until the V3 integration has been validated in a staging deployment. The recommended rollout is to mount V3 behind a feature flag, verify authentication, microphone permissions, token acquisition, cue assets, captions, interruption behavior, and telemetry, and only then switch the product entry point.

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
    // Optional: inject a preloaded WASM/Piper adapter through realtimeTtsOptions.
    realtimeTtsOptions: { localModel: preloadedPiperAdapter },
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

## 3. Realtime TTS backchannel endpoint

Production verbal cues use `RealtimeTTSProvider`; `StaticAssetCueProvider` is only a fallback for environments that deliberately choose it. The backend must expose an authenticated `POST /api/voice/v3/tts` route with this exact JSON request:

```json
{
  "text": "mhm",
  "persona": "Kore",
  "emotion": "neutral",
  "format": "pcm16",
  "sampleRate": 24000
}
```

The response must be:

```json
{
  "audioBase64": "<mono PCM16 little-endian bytes>",
  "durationMs": 300
}
```

The backend should route this request through the same TTS engine and voice identity used by the active Gemini voice persona. It should authenticate the request with the same Firebase/App Check headers as the token endpoint, enforce short cue-text and duration limits, and cache generated PCM16 for common persona/emotion/cue combinations such as `mhm` and `yeah`. Do not cache across personas or emotional styles.

`RealtimeTTSProvider` sends the network request first and uses a bounded network timeout. If the endpoint is slow or unavailable, it calls an injected local model adapter. The adapter represents a preloaded WebAssembly/Piper-style model and must implement `initialize()` once plus `generate(request)`. If both paths fail, the provider emits a short, gender-neutral 220 Hz hum rather than blocking the conversation. The provider also keeps a bounded browser cache for repeated cues.

The conductor begins a background generation request at the 150 ms RMS-decay point. If the user resumes before the 600 ms approval boundary, the pending audio is discarded. If silence reaches 600 ms and the generated chunk is ready, it is sent immediately through the existing LayerLink playback command path. This keeps the cue decision separate from playback and prevents a stale prefetch from leaking into a resumed user turn.

## 4. Persona voice catalog and live TTS validation

Sprint 12 requires an explicit backend mapping between every enabled Gemini persona and its TTS provider voice ID. Configure the current catalog with the following backend environment variables:

```text
CAMB_KORE_VOICE_ID=<explicit CAMB voice ID>
CAMB_CHARON_VOICE_ID=<explicit CAMB voice ID>
```

There is deliberately no default voice ID. If an ID is missing or the persona is unknown, `POST /api/voice/v3/tts` returns an empty-audio response with `fallback: "non_verbal_hum"`, logs `tts.persona_mapping_missing`, and the browser plays the non-verbal hum. Provider API keys and credentials remain backend-only. The catalog’s public diagnostic representation uses `REQUIRED` instead of exposing unset or secret values.

The endpoint resolves the persona before invoking TTS and uses a cache key containing the normalized persona, emotion, cue text, and sample rate. Common cues are `mhm`, `yeah`, `aha`, `right`, and `okay`; repeated requests for the same persona/style are served from the bounded cache. The response may include `cached`, `voiceId`, and `persona` metadata for internal diagnostics.

The current CAMB catalog entries do not advertise emotional-style support. The backend therefore ignores the requested emotion gracefully, keeps the resolved persona voice, and logs `tts.emotion_unsupported`. If a provider or older backend rejects a non-neutral emotion, the client retries once with `neutral`; it never substitutes a default persona voice. Malformed audio, missing mappings, unavailable providers, and exhausted fallback paths all result in the non-verbal hum.

Run the persona verification utility after configuring voice IDs and authentication. It exercises `mhm/neutral`, `okay/calm`, `yeah/excited`, and `aha/attentive` for each selected persona, saves reviewable mono 24 kHz PCM16 WAV samples, and writes a metadata manifest without storing the Firebase or App Check tokens:

```bash
python scripts/verify_voice_personas.py \
  --base-url https://mindpal.example.com \
  --token "$FIREBASE_ID_TOKEN" \
  --app-check "$FIREBASE_APP_CHECK_TOKEN" \
  --output-dir voice-persona-samples
```

Human review must confirm that each sample’s voice matches the active Gemini persona. A successful HTTP response alone is not evidence of voice identity.

## 5. Production feature flags and launch gate

V3 is controlled by five flags: `VOICE_V3_ENABLED`, `VOICE_V3_VERBAL_CUES_ENABLED`, `VOICE_V3_PROSODY_CONTEXT_ENABLED`, `VOICE_V3_MEMORY_ENABLED`, and `VOICE_V3_CLARIFICATION_ENABLED`. They can be supplied through Vite `VITE_` variables, a runtime `__MINDPAL_VOICE_V3_FLAGS__` object, or explicit user/session overrides. Session overrides take precedence over user overrides, which take precedence over environment values. When `VOICE_V3_ENABLED=false`, the hook does not create a V3 app and the existing V2 integration remains responsible for voice. Disabling verbal cues selects the non-verbal provider; disabling prosody context prevents any context note from reaching Gemini.

The backend mirrors the flags as typed settings and supports deterministic rollout through `VOICE_V3_ROLLOUT_PERCENT` plus user/session overrides. The backend startup launch gate validates every enabled persona against `PersonaVoiceCatalog`. It records missing mappings, endpoint probe failures, and cache-warm failures, and marks verbal cues unavailable for the affected launch without crashing the service or blocking V2.

Required production settings are:

```text
VOICE_V3_ENABLED=false
VOICE_V3_ROLLOUT_PERCENT=0
VOICE_V3_ENABLED_PERSONAS=Kore,Charon
CAMB_KORE_VOICE_ID=<explicit configured provider voice ID>
CAMB_CHARON_VOICE_ID=<explicit configured provider voice ID>
```

Enable `VOICE_V3_ENABLED` only after the voice IDs are configured, the endpoint is reachable, the neutral common-cue warm step succeeds, and human review confirms each persona’s samples. A failed gate must result in verbal cues being disabled, not in a guessed provider voice.

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

Use `providerMode: "real"` with a `RealTokenProvider` in production. `PRODUCTION_MODE` defaults to Vite’s production build flag, while an explicit `productionMode` option can be used by a staging harness. The mock transport and synthetic cue path remain available for local deterministic tests.

The first staging pass should use a feature flag and record the following operational checks: authenticated token success, WebSocket setup completion, AudioContext resume after the user gesture, microphone permission handling, realtime TTS request authentication, persona/voice matching, network-to-local timeout behavior, non-verbal fallback, predictive prefetch at 150 ms, discard on resumed speech, approval at 600 ms, PCM playback at 24 kHz, caption release after scheduled playback, barge-in flush, reconnect behavior, and telemetry POST status.

## 9. Local WASM model setup

The local model is intentionally injected rather than hard-coded to a browser-specific WASM package. Load the model weights before the first voice session, keep them in memory for the session, and adapt its output to `RealtimeTtsResponse` with mono PCM16 at 24 kHz. The adapter must not send user speech or assistant transcripts to the local model; it receives only the short, policy-approved cue text, persona, and emotion. If model loading fails, leave the adapter unavailable and allow the non-verbal fallback to handle the cue.

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

The isolated V3 entrypoint serves `/voice-v3-review` as a review-only page. It calls authenticated `GET /api/voice/v3/personas` for the public catalog representation, which reports `REQUIRED` for missing mappings rather than exposing credentials. For configured Kore and Charon personas, the reviewer can fetch the common cue set (`mhm`, `yeah`, `aha`, `right`, and `okay`) through the existing authenticated `POST /api/voice/v3/tts` contract, play mono 24 kHz PCM16 samples, record pass/fail/unsure comments, and export a JSON review artifact.

The review page is not a rollout control. A `GO` result requires configured mappings, loaded samples, and a pass for every cue; missing mappings or any failed cue remain `NO-GO`/pending. Save exported artifacts under `artifacts/voice-persona-review/`, which is ignored by Git.

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
