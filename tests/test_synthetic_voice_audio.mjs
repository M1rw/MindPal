import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCaptureAdapter } from "../frontend/js/voice/capture/capture_adapter.js";
import {
  advanceVoiceNoiseGate,
  getVoiceCapturePolicy,
} from "../frontend/js/voice/conversation_policy.js";
import { getBackchannelDecision as getPresenceDecision } from "../frontend/js/voice/backchannel/backchannel_policy.js";
import { createVoiceSessionOrchestrator } from "../frontend/js/voice/orchestrator/voice_session_orchestrator.js";
import { VOICE_EVENTS } from "../frontend/js/voice/architecture/events.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(ROOT, "fixtures", "voice_synthetic");
const FRAME_SAMPLES = 320;
const FRAME_MS = 20;

function readPcmFixture(name) {
  const bytes = readFileSync(join(FIXTURES, name));
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1, "fixtures must be mono");
  assert.equal(bytes.readUInt16LE(34), 16, "fixtures must be PCM16");
  assert.equal(bytes.readUInt32LE(24), 16_000, "fixtures must match capture sample rate");
  const dataOffset = 44;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + dataOffset, (bytes.length - dataOffset) / 2);
  return Float32Array.from(pcm, (value) => value / 0x7fff);
}

function splitFrames(samples) {
  const frames = [];
  for (let offset = 0; offset + FRAME_SAMPLES <= samples.length; offset += FRAME_SAMPLES) {
    frames.push(samples.slice(offset, offset + FRAME_SAMPLES));
  }
  return frames;
}

function frameRms(frame) {
  let sum = 0;
  for (const value of frame) sum += value * value;
  return Math.sqrt(sum / frame.length);
}

test("synthetic fixtures are valid capture streams and mute suppresses PCM emission", () => {
  const samples = readPcmFixture("long_story.wav");
  const frames = splitFrames(samples);
  let now = 0;
  let audioFrames = 0;
  let qualityFrames = 0;
  const capture = createCaptureAdapter({
    now: () => now,
    onAudio: () => { audioFrames += 1; },
    onQuality: () => { qualityFrames += 1; },
  });

  capture.start();
  for (const frame of frames) {
    capture.processFrame(frame);
    now += FRAME_MS;
  }
  const beforeMute = capture.getFrameCount();
  capture.setMuted(true);
  capture.processFrame(frames[0]);
  capture.setMuted(false);
  capture.processFrame(frames[0]);

  assert.equal(qualityFrames, frames.length + 1);
  assert.equal(audioFrames, frames.length + 1);
  assert.equal(beforeMute, frames.length);
  assert.equal(capture.getFrameCount(), frames.length + 1);
});

test("synthetic background noise does not confirm speech before speech begins, then confirms sustained speech", () => {
  const frames = splitFrames(readPcmFixture("background_noise.wav"));
  let signal = { noiseFloorRms: 0.0025, speechFrameStreak: 0 };
  let firstConfirmedFrame = -1;
  const noiseFrameCount = Math.floor(1.5 * 1000 / FRAME_MS);

  frames.forEach((frame, index) => {
    const result = advanceVoiceNoiseGate(signal, frameRms(frame));
    signal = result.next;
    if (result.confirmedSpeech && firstConfirmedFrame < 0) firstConfirmedFrame = index;
  });

  assert.ok(firstConfirmedFrame >= noiseFrameCount, `confirmed speech at frame ${firstConfirmedFrame} before noise ended at ${noiseFrameCount}`);
  assert.ok(firstConfirmedFrame < frames.length, "speech segment should eventually be confirmed");
});

test("synthetic interruption ducks model audio within one capture frame and releases after the gap", () => {
  const frames = splitFrames(readPcmFixture("sudden_interruption.wav"));
  let now = 0;
  const duckEvents = [];
  const playback = {
    schedule: () => {},
    setOptimisticDucked: (ducked) => duckEvents.push({ ducked, at: now }),
    handleInterruption: () => 1,
    flush: () => {},
  };
  const provider = {
    connect: () => {},
    updateContext: () => {},
    close: () => {},
  };
  const capture = { start: () => true, stop: () => true, processFrame: () => true };
  const orchestrator = createVoiceSessionOrchestrator({ provider, capture, playback, now: () => now });
  orchestrator.start({ url: "wss://test.invalid", setup: {}, identity: { sessionGeneration: "s1" } });
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_READY });
  orchestrator.handleProviderEvent({ type: VOICE_EVENTS.PROVIDER_AUDIO, base64Data: "AA==" });

  let firstDuckAt = null;
  let firstReleaseAt = null;
  for (const frame of frames) {
    orchestrator.handleCaptureQuality({ rms: frameRms(frame) });
    if (firstDuckAt == null && duckEvents.some((event) => event.ducked)) firstDuckAt = now;
    if (firstReleaseAt == null && duckEvents.some((event) => !event.ducked)) firstReleaseAt = now;
    now += FRAME_MS;
  }

  assert.equal(duckEvents[0]?.ducked, true);
  assert.ok(firstDuckAt !== null, "model audio should duck when interruption speech starts");
  assert.ok(firstReleaseAt !== null, "ducking should release after the interruption gap");
  assert.ok(firstDuckAt <= FRAME_MS, `ducking latency exceeded one frame: ${firstDuckAt}ms`);
  assert.ok(firstReleaseAt > firstDuckAt);
});

test("long-story synthetic pauses expose a cue window without closing the user turn", () => {
  const earlyPause = getPresenceDecision({
    turnId: "synthetic-story-1",
    speechDurationMs: 3_000,
    pauseDurationMs: 350,
    transcriptConfidence: 1,
    userHasYielded: false,
    topic: "story",
    emotion: "neutral",
    language: "en-US",
  });
  const eligiblePause = getPresenceDecision({
    turnId: "synthetic-story-1",
    speechDurationMs: 10_400,
    pauseDurationMs: 450,
    transcriptConfidence: 1,
    userHasYielded: false,
    topic: "story",
    emotion: "neutral",
    language: "en-US",
  });

  assert.equal(earlyPause.offer, false);
  assert.equal(eligiblePause.offer, true);
  assert.equal(eligiblePause.reason, "eligible");
  assert.equal(getVoiceCapturePolicy({ confirmedSpeech: true, isAiSpeaking: true }).activity, "barge-in-pending");
});
