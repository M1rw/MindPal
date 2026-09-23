import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPTURE_CUTOFF_HZ, CAPTURE_TAPS, Decimator, designLowpass, responseDb } from '../../frontend/src/voice/audio/resample.ts';
import { CAPTURE_CONSTRAINTS, CAPTURE_WORKLET_SOURCE } from '../../frontend/src/voice/audio/capture.ts';
import { AudioRing, ContinuousResampler, JITTER_MAX_MS, JITTER_MIN_MS, JitterTarget, MODEL_RATE, softLimit } from '../../frontend/src/voice/audio/playbackCore.ts';
import { PLAYBACK_WORKLET_SOURCE } from '../../frontend/src/voice/audio/playbackWorklet.ts';
import { PlaybackQueue } from '../../frontend/src/voice/audio/playback.ts';

const IN_RATE = 48000;
const OUT_RATE = 16000;

function tone(hz, samples, rate) {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Magnitude at one frequency, normalised so a pure unit tone reads ~1. */
function goertzel(signal, hz, rate) {
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const s = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (signal.length / 2);
}

function maxStep(signal, from = 0) {
  let m = 0;
  for (let i = from + 1; i < signal.length; i += 1) m = Math.max(m, Math.abs(signal[i] - signal[i - 1]));
  return m;
}

function runDecimator(dec, signal, block) {
  const out = [];
  for (let i = 0; i < signal.length; i += block) {
    const chunk = dec.process(signal.subarray(i, i + block));
    for (let k = 0; k < chunk.length; k += 1) out.push(chunk[k]);
  }
  return Float32Array.from(out);
}

/** The pre-fix behaviour: keep every Nth sample, no filter. */
function naiveDecimate(signal, ratio) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < signal.length; i += 1) {
    acc += 1;
    if (acc >= ratio) {
      acc -= ratio;
      out.push(signal[i]);
    }
  }
  return Float32Array.from(out);
}

describe('capture anti-aliasing', () => {
  it('rejects content above the 16 kHz Nyquist that naive decimation folded back', () => {
    // 12 kHz at 48 k input aliases onto 4 kHz at 16 k output — right in the
    // speech band, which is why the unfiltered version was audible as grit.
    const signal = tone(12000, IN_RATE, IN_RATE);
    const before = naiveDecimate(signal, IN_RATE / OUT_RATE);
    const after = runDecimator(new Decimator(IN_RATE, OUT_RATE), signal, 128);

    const aliasBefore = goertzel(before.subarray(2000), 4000, OUT_RATE);
    const aliasAfter = goertzel(after.subarray(2000), 4000, OUT_RATE);

    assert.ok(aliasBefore > 0.9, `naive decimation should alias at full scale, got ${aliasBefore}`);
    assert.ok(aliasAfter < 0.01, `filtered decimation must suppress the alias, got ${aliasAfter}`);
    assert.ok(aliasAfter * 1000 < aliasBefore, 'alias rejection must be at least 60 dB');
  });

  it('keeps the speech band at unity so the filter is not a tone control', () => {
    const out = runDecimator(new Decimator(IN_RATE, OUT_RATE), tone(1000, IN_RATE, IN_RATE), 128);
    const mag = goertzel(out.subarray(2000), 1000, OUT_RATE);
    assert.ok(mag > 0.97 && mag < 1.03, `1 kHz should pass at unity, got ${mag}`);

    const kernel = designLowpass(CAPTURE_TAPS, CAPTURE_CUTOFF_HZ / IN_RATE);
    assert.ok(responseDb(kernel, 300, IN_RATE) > -0.5, 'low speech must not be attenuated');
    assert.ok(responseDb(kernel, 6000, IN_RATE) > -1.5, 'sibilance region must stay close to flat');
    assert.ok(responseDb(kernel, 10000, IN_RATE) < -60, 'stopband must be deep by 10 kHz');
  });

  it('is continuous across block boundaries, so there is no per-block seam', () => {
    const signal = tone(1000, IN_RATE, IN_RATE);
    const whole = runDecimator(new Decimator(IN_RATE, OUT_RATE), signal, signal.length);
    // A deliberately awkward block size: 137 never divides evenly into the ratio.
    const chunked = runDecimator(new Decimator(IN_RATE, OUT_RATE), signal, 137);
    const n = Math.min(whole.length, chunked.length);
    let worst = 0;
    for (let i = 0; i < n; i += 1) worst = Math.max(worst, Math.abs(whole[i] - chunked[i]));
    assert.ok(worst < 1e-6, `chunked output must match whole-signal output, drift ${worst}`);
  });

  it('handles a non-integer device rate', () => {
    const out = runDecimator(new Decimator(44100, OUT_RATE), tone(1000, 44100, 44100), 128);
    assert.ok(Math.abs(out.length - OUT_RATE) < 32, `44.1k -> 16k should yield ~16000, got ${out.length}`);
    assert.ok(goertzel(out.subarray(2000), 1000, OUT_RATE) > 0.95);
  });

  it('runs the same maths in the worklet as in the testable module', () => {
    // The worklet is a source string in its own realm and cannot import, so the
    // two copies can drift. Execute the real worklet source against a stub and
    // compare sample-for-sample.
    const frames = [];
    class StubProcessor {
      constructor() {
        this.port = { postMessage: (msg) => frames.push(msg) };
      }
    }
    const factory = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      `${CAPTURE_WORKLET_SOURCE}; return MindPalPcmCaptureProcessor;`,
    );
    let registeredName = '';
    const Processor = factory(StubProcessor, (name) => {
      registeredName = name;
    }, IN_RATE);
    assert.equal(registeredName, 'mindpal-pcm-capture');

    const processor = new Processor();
    const signal = tone(3000, IN_RATE, IN_RATE);
    const workletOut = [];
    for (let i = 0; i < signal.length; i += 128) {
      const block = signal.subarray(i, i + 128);
      processor.process([[block]]);
    }
    frames.forEach((frame) => {
      const pcm = new Int16Array(frame.pcm);
      for (let i = 0; i < pcm.length; i += 1) workletOut.push(pcm[i] / 0x8000);
    });

    const moduleOut = runDecimator(new Decimator(IN_RATE, OUT_RATE), signal, 128);
    assert.ok(workletOut.length > 1000, 'worklet should emit frames');
    let worst = 0;
    for (let i = 0; i < workletOut.length; i += 1) {
      worst = Math.max(worst, Math.abs(workletOut[i] - moduleOut[i]));
    }
    // Int16 quantisation is the only permitted difference.
    assert.ok(worst < 2e-4, `worklet and module must agree, worst delta ${worst}`);
  });

  it('does not stack browser AGC on top of the in-app normaliser', () => {
    assert.equal(CAPTURE_CONSTRAINTS.autoGainControl, false);
    assert.equal(CAPTURE_CONSTRAINTS.echoCancellation, true, 'AEC is load-bearing for barge-in');
    assert.equal(CAPTURE_CONSTRAINTS.noiseSuppression, true);
  });
});

describe('continuous playback', () => {
  it('has no chunk-boundary discontinuity, unlike per-chunk resampling', () => {
    const src = tone(440, MODEL_RATE, MODEL_RATE);
    const deviceRate = 48000;

    const continuous = new ContinuousResampler(MODEL_RATE, deviceRate);
    const streamed = [];
    for (let i = 0; i < src.length; i += 480) {
      const out = continuous.process(src.subarray(i, i + 480));
      for (let k = 0; k < out.length; k += 1) streamed.push(out[k]);
    }

    // The old path: a fresh resampling context per provider chunk.
    const perChunk = [];
    for (let i = 0; i < src.length; i += 480) {
      const fresh = new ContinuousResampler(MODEL_RATE, deviceRate);
      const out = fresh.process(src.subarray(i, i + 480));
      for (let k = 0; k < out.length; k += 1) perChunk.push(out[k]);
    }

    const ideal = maxStep(tone(440, deviceRate, deviceRate));
    const streamedStep = maxStep(Float32Array.from(streamed), 10);
    const perChunkStep = maxStep(Float32Array.from(perChunk), 10);

    assert.ok(
      streamedStep < ideal * 1.05,
      `continuous stream must match a natively generated one (${streamedStep} vs ${ideal})`,
    );
    assert.ok(
      perChunkStep > ideal * 2,
      `per-chunk resampling should show the seam this replaces (${perChunkStep})`,
    );
    assert.ok(Math.abs(streamed.length - deviceRate) < 4, 'sample count must track the rate ratio');
  });

  it('rings safely: pads underruns with silence and drops oldest on overrun', () => {
    const ring = new AudioRing(1024);
    ring.write(Float32Array.from({ length: 600 }, (_, i) => i + 1));
    const first = new Float32Array(400);
    assert.equal(ring.read(first), 400);
    assert.equal(first[0], 1);
    assert.equal(ring.length, 200);

    const second = new Float32Array(400);
    assert.equal(ring.read(second), 200, 'short read reports what it had');
    assert.equal(second[399], 0, 'shortfall is silence, never stale audio');

    const small = new AudioRing(1024);
    small.write(new Float32Array(2000));
    assert.equal(small.length, small.capacity);
    assert.ok(small.dropped > 0, 'overrun must drop the oldest audio, not wrap over live audio');
  });

  it('widens the jitter target on starvation and recovers when clean', () => {
    const jitter = new JitterTarget();
    assert.equal(jitter.valueMs, JITTER_MIN_MS);
    jitter.noteUnderrun();
    assert.ok(jitter.valueMs > JITTER_MIN_MS, 'an underrun must buy headroom');
    for (let i = 0; i < 40; i += 1) jitter.noteUnderrun();
    assert.equal(jitter.valueMs, JITTER_MAX_MS, 'headroom is capped so latency cannot run away');
    for (let i = 0; i < 2000; i += 1) jitter.noteClean();
    assert.equal(jitter.valueMs, JITTER_MIN_MS, 'a clean network returns to low latency');
  });

  it('limits peaks smoothly instead of clipping', () => {
    assert.equal(softLimit(0.5), 0.5, 'below the knee is untouched');
    assert.ok(softLimit(1.4) < 1, 'over-unity is contained');
    assert.ok(softLimit(1.4) > 0.95, 'containment is not a volume drop');
    assert.equal(softLimit(-1.4), -softLimit(1.4), 'limiter is symmetric');
    let previous = -Infinity;
    for (let v = -2; v <= 2; v += 0.01) {
      const y = softLimit(v);
      assert.ok(y >= previous - 1e-9, 'transfer curve must stay monotonic');
      previous = y;
    }
  });

  it('registers a playback processor that mirrors the shared limiter', () => {
    assert.ok(PLAYBACK_WORKLET_SOURCE.includes('mindpal-pcm-playback'));
    assert.ok(
      PLAYBACK_WORKLET_SOURCE.includes(String(MODEL_RATE)),
      'worklet must be pinned to the provider output rate',
    );
  });
});


describe('releasing the barge-in fence mid-fade', () => {
  /** Just enough of an AudioContext for the fallback fade path. */
  function wiredQueue() {
    const queue = new PlaybackQueue();
    const param = { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, setValueCurveAtTime() {} };
    queue['context'] = { currentTime: 0, state: 'running' };
    queue['gain'] = { gain: param };
    return queue;
  }

  it('finishes the fade instead of leaving playback stuck (trace 18-53)', () => {
    // Interrupt, then turn_complete 5ms later released the fence while the
    // 180ms fade was still running. The fade timer then bailed on the newer
    // generation, `fading` stayed true, and the next reply never played.
    const queue = wiredQueue();
    queue.flush();
    assert.equal(queue.isFading, true);
    queue.releaseFence();
    assert.equal(queue.isFading, false, 'fade completed on release');
    assert.equal(queue.isGated, false);
    assert.equal(queue.isPlaying(), false, 'idle, ready for the next reply');
  });

  it('still completes a fade on its own timer when nothing releases it early', async () => {
    const queue = wiredQueue();
    queue.flush();
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(queue.isFading, false);
  });
});

describe('what counts as an underrun', () => {
  function streamQueue() {
    const queue = new PlaybackQueue();
    const posted = [];
    queue['streamNode'] = { port: { postMessage: (m) => posted.push(m) } };
    queue['context'] = { currentTime: 0, state: 'running' };
    queue['gain'] = { gain: { value: 1 } };
    return { queue, posted };
  }

  it('does not count a reply that simply ended', async () => {
    const { queue } = streamQueue();
    queue['onStreamMessage']({ type: 'underrun' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    queue.enqueue(new Int16Array(480));
    assert.equal(queue.jitterSnapshot().underruns, 0);
    assert.equal(queue.jitterSnapshot().targetMs, 70, 'no added latency');
  });

  it('counts audio resuming right after running dry, and widens the buffer', () => {
    const { queue, posted } = streamQueue();
    queue['onStreamMessage']({ type: 'underrun' });
    queue.enqueue(new Int16Array(480));
    assert.equal(queue.jitterSnapshot().underruns, 1);
    assert.ok(posted.some((m) => m.type === 'prebuffer' && m.ms > 70));
  });

  it('does not count running dry because the caller cut MindPal off', () => {
    const { queue } = streamQueue();
    queue['onStreamMessage']({ type: 'underrun' });
    queue.flush();
    queue.releaseFence();
    queue.enqueue(new Int16Array(480));
    assert.equal(queue.jitterSnapshot().underruns, 0);
  });
});
