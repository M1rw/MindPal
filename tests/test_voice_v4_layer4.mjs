import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYBACK_ERROR_CODES,
  VoicePlaybackError,
  createPlayback,
} from "../frontend/js/features/voice/playback/playback.js";

function createFakeAudio() {
  const sources = [];
  const context = {
    currentTime: 10,
    state: "suspended",
    destination: {},
    async resume() { this.state = "running"; },
    async close() { this.state = "closed"; },
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    },
    createBuffer(_channels, length, sampleRate) {
      assert.equal(sampleRate, 24000);
      const channel = new Float32Array(length);
      return {
        duration: length / sampleRate,
        copyToChannel(samples) { channel.set(samples); },
        getChannelData() { return channel; },
      };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        startTime: null,
        stopped: false,
        connect() {},
        start(when) { this.startTime = when; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources };
}

function pcm16(...samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

test("playback schedules mono 24 kHz chunks in order and exposes numeric snapshots", async () => {
  const fake = createFakeAudio();
  const snapshots = [];
  const playback = createPlayback({
    AudioContextConstructor: class {
      constructor() { return fake.context; }
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  await playback.start();
  const first = playback.schedulePcm24(pcm16(0, 32767));
  const second = playback.schedulePcm24(pcm16(-32768, 0));
  assert.equal(first.activeSourceCount, 1);
  assert.equal(second.activeSourceCount, 2);
  assert.equal(fake.sources[0].startTime, 10.01);
  assert.ok(Math.abs(fake.sources[1].startTime - 10.010083333333334) < 1e-12);
  assert.equal(second.queueDepthMs, 10);
  assert.equal(second.outputBytes, undefined);
  assert.ok(snapshots.every((snapshot) => snapshot.audioContextState !== "playing" || !("audio" in snapshot)));
});

test("drain requires every scheduled source to end and queue time to reach zero", async () => {
  const fake = createFakeAudio();
  const drains = [];
  const playback = createPlayback({
    AudioContextConstructor: class { constructor() { return fake.context; } },
  });
  playback.onDrain((snapshot) => drains.push(snapshot));
  await playback.start();
  playback.schedulePcm24(pcm16(0, 1));
  playback.schedulePcm24(pcm16(1, 0));

  fake.sources[0].onended();
  assert.equal(drains.length, 0);
  fake.context.currentTime = 10.02;
  fake.sources[1].onended();
  assert.equal(drains.length, 1);
  assert.equal(drains[0].activeSourceCount, 0);
  assert.equal(drains[0].queueDepthMs, 0);
});

test("flush increments playback epoch and fences stale ended callbacks", async () => {
  const fake = createFakeAudio();
  const drains = [];
  const playback = createPlayback({
    AudioContextConstructor: class { constructor() { return fake.context; } },
  });
  playback.onDrain(() => drains.push(true));
  await playback.start();
  playback.schedulePcm24(pcm16(0, 0));
  const oldSource = fake.sources[0];
  const oldEpoch = playback.getEpoch();
  const flushed = playback.flush("interrupted");
  assert.equal(flushed.playbackEpoch, oldEpoch + 1);
  assert.equal(flushed.activeSourceCount, 0);
  assert.equal(oldSource.stopped, true);

  playback.schedulePcm24(pcm16(0, 0));
  oldSource.onended();
  assert.equal(playback.getSnapshot().activeSourceCount, 1);
  fake.context.currentTime = 10.02;
  fake.sources[1].onended();
  assert.equal(drains.length, 1);
});

test("playback rejects invalid lifecycle and PCM input and closes its context", async () => {
  const fake = createFakeAudio();
  const errors = [];
  const playback = createPlayback({
    AudioContextConstructor: class { constructor() { return fake.context; } },
    onError: (error) => errors.push(error),
  });
  assert.throws(() => playback.schedulePcm24(pcm16(0)), (error) => error instanceof VoicePlaybackError && error.code === PLAYBACK_ERROR_CODES.NOT_STARTED);
  await playback.start();
  assert.throws(() => playback.schedulePcm24(new Uint8Array([0])), (error) => error.code === PLAYBACK_ERROR_CODES.INVALID_CHUNK);
  await playback.close();
  assert.equal(playback.getSnapshot().state, "CLOSED");
  assert.equal(fake.context.state, "closed");
  assert.deepEqual(errors.map((error) => error.code), [PLAYBACK_ERROR_CODES.NOT_STARTED, PLAYBACK_ERROR_CODES.INVALID_CHUNK]);
});
