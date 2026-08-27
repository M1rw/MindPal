import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_ERROR_CODES,
  buildMicrophoneConstraints,
  inspectCaptureCapabilities,
  mapCaptureError,
} from "../frontend/js/features/voice_v4/layer3/capabilities.js";
import {
  CAPTURE_FRAME_SAMPLES,
  createFrameAccumulator,
  createStreamingResampler,
  downmixToMono,
  encodeMonoPcm16LittleEndian,
  resampleMonoTo16k,
} from "../frontend/js/features/voice_v4/layer3/signal_processing.js";
import {
  createMicrophoneCapture,
  VoiceCaptureError,
} from "../frontend/js/features/voice_v4/layer3/microphone_capture.js";

function fakeCapabilities() {
  return inspectCaptureCapabilities({
    secureContext: true,
    mediaDevices: { getUserMedia: async () => ({}) },
    AudioContextConstructor: class AudioContext {},
    AudioWorkletNodeConstructor: class AudioWorkletNode {},
  });
}

test("capability checks fail closed and normalize browser permission errors", () => {
  assert.equal(inspectCaptureCapabilities({ secureContext: false }).errorCode, CAPTURE_ERROR_CODES.INSECURE_CONTEXT);
  assert.equal(inspectCaptureCapabilities({ secureContext: true }).errorCode, CAPTURE_ERROR_CODES.MEDIA_DEVICES_UNAVAILABLE);
  assert.equal(fakeCapabilities().available, true);
  assert.equal(mapCaptureError({ name: "NotAllowedError" }), CAPTURE_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(mapCaptureError({ name: "NotFoundError" }), CAPTURE_ERROR_CODES.DEVICE_NOT_FOUND);
  assert.equal(mapCaptureError({ name: "NotReadableError" }), CAPTURE_ERROR_CODES.DEVICE_UNREADABLE);
  assert.equal(mapCaptureError({ name: "OverconstrainedError" }), CAPTURE_ERROR_CODES.CONSTRAINT_FAILED);
  assert.equal(mapCaptureError({ name: "UnexpectedError" }), CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE);

  const constraints = buildMicrophoneConstraints();
  assert.equal(constraints.audio.channelCount.ideal, 1);
  assert.equal(constraints.audio.echoCancellation.ideal, false);
  assert.equal(constraints.audio.noiseSuppression.ideal, false);
  assert.equal(constraints.audio.autoGainControl.ideal, false);
  assert.equal(constraints.video, false);
});

test("signal processing downmixes, resamples, clips, and encodes little-endian PCM16", () => {
  const mono = downmixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual([...mono], [0.5, 0.5]);
  assert.equal(resampleMonoTo16k(new Float32Array([0, 1, 0, 1]), 16000).length, 4);
  assert.equal(resampleMonoTo16k(new Float32Array(480), 48000).length, 160);

  const encoded = encodeMonoPcm16LittleEndian(new Float32Array([-1, 0, 1, 2]));
  assert.deepEqual([...encoded], [0, 128, 0, 0, 255, 127, 255, 127]);
});

test("streaming resampler and frame accumulator preserve bounded exact frames", () => {
  const resampler = createStreamingResampler(48000);
  const accumulator = createFrameAccumulator();
  const first = accumulator.push(resampler.push(new Float32Array(960)));
  assert.equal(first.length, 1);
  assert.equal(first[0].length, CAPTURE_FRAME_SAMPLES);
  assert.equal(accumulator.pendingSampleCount(), 0);
  assert.ok(resampler.pendingSampleCount() <= 2);

  const partial = accumulator.push(new Float32Array(CAPTURE_FRAME_SAMPLES - 1));
  assert.equal(partial.length, 0);
  assert.equal(accumulator.pendingSampleCount(), CAPTURE_FRAME_SAMPLES - 1);
  accumulator.reset();
  assert.equal(accumulator.pendingSampleCount(), 0);
});

test("microphone capture creates one graph, emits 20 ms frames, and stops late worklet messages", async () => {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  let workletNode;
  let context;
  const states = [];
  const frames = [];
  const errors = [];
  const mediaDevices = {
    getUserMedia: async (constraints) => {
      assert.equal(constraints.video, false);
      return stream;
    },
  };
  class FakeAudioContext {
    constructor(options) {
      context = this;
      this.options = options;
      this.sampleRate = 48000;
      this.state = "suspended";
      this.audioWorklet = { addModule: async (url) => { this.processorUrl = url; } };
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  }
  class FakeAudioWorkletNode {
    constructor() {
      workletNode = this;
      this.port = { onmessage: null };
    }
    connect() {}
    disconnect() {}
  }

  const capture = createMicrophoneCapture({
    processorUrl: "/layer3-worklet.js",
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
    onStateChange: (state) => states.push(state),
    secureContext: true,
    mediaDevices,
    AudioContextConstructor: FakeAudioContext,
    AudioWorkletNodeConstructor: FakeAudioWorkletNode,
  });

  await capture.start();
  assert.equal(capture.getState(), "CAPTURING");
  assert.equal(context.options.latencyHint, "interactive");
  assert.equal(context.processorUrl, "/layer3-worklet.js");
  workletNode.port.onmessage({ data: { channels: [new Float32Array(960)] } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, CAPTURE_FRAME_SAMPLES * 2);
  assert.equal(errors.length, 0);

  await capture.pause();
  assert.equal(capture.getState(), "PAUSED");
  assert.equal(track.enabled, false);
  workletNode.port.onmessage({ data: { channels: [new Float32Array(960)] } });
  assert.equal(frames.length, 1);

  await capture.resume();
  assert.equal(capture.getState(), "CAPTURING");
  assert.equal(track.enabled, true);
  await capture.stop();
  assert.equal(capture.getState(), "STOPPED");
  assert.equal(track.stopped, true);
  assert.equal(context.state, "closed");
  workletNode.port.onmessage?.({ data: { channels: [new Float32Array(960)] } });
  assert.equal(frames.length, 1);
  assert.deepEqual(states, ["REQUESTING", "CAPTURING", "PAUSED", "CAPTURING", "STOPPED"]);
});

test("microphone capture maps permission and worklet failures to safe errors", async () => {
  const errors = [];
  const denied = createMicrophoneCapture({
    processorUrl: "/layer3-worklet.js",
    onError: (error) => errors.push(error),
    secureContext: true,
    mediaDevices: { getUserMedia: async () => { throw { name: "NotAllowedError" }; } },
    AudioContextConstructor: class AudioContext {},
    AudioWorkletNodeConstructor: class AudioWorkletNode {},
  });
  await assert.rejects(() => denied.start(), (error) => error instanceof VoiceCaptureError && error.code === CAPTURE_ERROR_CODES.PERMISSION_DENIED);
  assert.equal(errors.at(-1).code, CAPTURE_ERROR_CODES.PERMISSION_DENIED);

  const missingUrl = createMicrophoneCapture({ onError: (error) => errors.push(error) });
  await assert.rejects(() => missingUrl.start(), (error) => error instanceof VoiceCaptureError && error.code === CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE);
});
