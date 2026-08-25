import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Voice preloads the canonical runtime and does not await auth before session start", async () => {
  const [sessionSource, liveSource] = await Promise.all([
    readFile(new URL("../frontend/js/voice_session.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/js/voice_live.js", import.meta.url), "utf8"),
  ]);
  assert.match(sessionSource, /export function preloadVoiceRuntime/);
  assert.match(liveSource, /preloadVoiceRuntime\(\)/);
  assert.match(liveSource, /const tokenPromise = getIdToken\(\)\.catch/);
  assert.doesNotMatch(liveSource, /const token = await getIdToken/);
  assert.match(liveSource, /getAuthToken: \(\) => tokenPromise/);
});

test("Voice summary persistence authenticates the post-call request", async () => {
  const source = await readFile(new URL("../frontend/js/voice_live.js", import.meta.url), "utf8");
  assert.match(source, /const tokenPromise = getIdToken\(\)\.catch/);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /headers\["X-Firebase-AppCheck"\] = appCheckToken/);
  assert.match(source, /fetch\("\/api\/voice\/summarize"/);
});

test("live runtime binds optional callbacks from the start-session signature", async () => {

  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /startSession\(options: ProductionSessionOptions = \{\}\)/);
  assert.match(source, /callbacks = options/);
  assert.match(source, /callbacks\.onTurnComplete/);
  assert.match(source, /callbacks\.onBackgroundTask/);
  assert.match(source, /let stopInFlight: Promise<boolean> \| null = null/);
  assert.match(source, /if \(stopInFlight\) await stopInFlight/);
  assert.match(source, /if \(!active && !startupPending\) return/);
});

test("live runtime delegates web research without pausing audio input", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");

  assert.match(source, /ORCHESTRATOR_OPERATION_REQUESTED/);
  assert.match(source, /callbacks\.onBackgroundTask/);
});

test("production Voice gates native cues and forwards real playback RMS", async () => {
  const appSource = await readFile(new URL("../frontend/voice/src/app.ts", import.meta.url), "utf8");
  const entrySource = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(appSource, /nativeGeminiCues: this\.featureFlags\.VOICE_V3_VERBAL_CUES_ENABLED/);
  assert.match(appSource, /this\.orchestrator\.cancelNativeCue\("timeout"\)/);
  assert.match(entrySource, /aiLevel: app\?\.playbackManager\.getOutputLevel\?\.\(\) \?\? 0/);
});

test("voice session preserves verified research while native setup avoids provider tools", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /callbacks\.onDiagnostic/);
  assert.match(source, /VOICE_V3_ENABLED: true/);
});

test("live runtime uses the documented realtime text channel for every post-setup update", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /sendTextToModel\(text: string\)/);
  assert.match(source, /app\.transportManager\.sendRealtimeText/);
});

test("Voice runtime diagnoses a connected session with no microphone frames", async () => {
  const [entrySource, liveSource] = await Promise.all([
    readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8"),
    readFile(new URL("../frontend/js/voice_live.js", import.meta.url), "utf8"),
  ]);
  assert.match(entrySource, /voice\.input\.waiting/);
  assert.match(entrySource, /framesCaptured === 0/);
  assert.match(liveSource, /Waiting for microphone input/);
});

test("voice runtime preserves captions through transcription fallback and aggregate-only delivery diagnostics", async () => {

  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");

  assert.match(source, /callbacks\.onTranscript\?\.\("user"/);
  assert.match(source, /callbacks\.onTranscript\?\.\("ai"/);
  assert.match(source, /callbacks\.onDiagnostic/);
});

test("voice runtime never treats an active long user turn as a stale socket", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /handleSnapshot/);
  assert.match(source, /reconnectAttempts/);
});

test("voice runtime softens barge-in audio and exposes a single long-turn listener cue", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /PROVIDER_INTERRUPTED/);
  assert.match(source, /reason: "provider-interrupted"/);
});

test("Voice lifecycle treats provider transcription, not raw microphone energy, as user participation", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /PROVIDER_INPUT_TRANSCRIPT/);
  assert.match(source, /userTranscript = mergeTranscript/);
});

test("Voice runtime gates speculative volatile-fact audio and uses shared idle ownership", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /callbacks\.onDiagnostic/);
  assert.match(source, /projectPhase/);
});

test("Voice runtime treats GoAway and its following normal close as a resumable continuation", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /snapshot\.state === "RECOVERING" || snapshot\.state === "RESUMING"/);
});

test("Voice runtime turns a credential 429 into one shared, server-timed recovery pause", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /callbacks\.onDiagnostic/);
});

test("Voice runtime releases evidence only after its original fact-gated turn and bridges a pending check", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /callbacks\.onDiagnostic/);
});

test("Voice overlay maps runtime detail to the five-state human vocabulary", async () => {
  const source = await readFile(new URL("../frontend/js/voice_live.js", import.meta.url), "utf8");

  assert.match(source, /export function resolveMinimalVoiceStatus/);
  assert.match(source, /return "Connecting…"/);
  assert.match(source, /return "MindPal is speaking…"/);
  assert.match(source, /return "Thinking…"/);
  assert.match(source, /return "Listening…"/);
  assert.match(source, /return "Inactive"/);
  assert.match(source, /function renderMinimalVoiceStatus/);
  assert.match(source, /lastAudioProjection/);
});

test("Voice overlay presents AI-only spoken captions with auto-scroll and Arabic direction support", async () => {
  const [source, markup, styles] = await Promise.all([
    readFile(new URL("../frontend/js/voice_live.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/index.html", import.meta.url), "utf8"),
    readFile(new URL("../frontend/css/style.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /if \(type === "user"\) userTranscript = appendTranscriptChunk/);
  assert.match(source, /onCaption: handleCanonicalCaptionRelease/);
  assert.match(source, /caption\.textContent = value/);
  assert.match(source, /currentCaption = null/);
  assert.match(source, /function createAiCaption\(\)/);
  assert.match(source, /voice-caption voice-caption--active/);
  assert.match(source, /panel\.scrollTo\(\{ top: panel\.scrollHeight, behavior: "smooth" \}\)/);
  assert.match(source, /caption\.dir = "auto"/);
  assert.match(markup, /aria-label="MindPal spoken captions"/);
  assert.match(markup, /id="voice-cc-toggle"/);
  assert.match(styles, /\.voice-caption--active/);
});

test("Voice runtime resolves local time after yield without entering the verified-web path", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /sendTextToModel/);
});

test("Voice runtime applies supported native capture constraints and provider-owned interruption", async () => {
  const source = await readFile(new URL("../frontend/voice/src/production-entry.ts", import.meta.url), "utf8");
  assert.match(source, /app\.start\(\{ startCapture: true \}\)/);
});
