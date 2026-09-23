/**
 * Real-browser verification of the two audio worklets.
 *
 * The DSP in resample.ts / playbackCore.ts is unit-tested in
 * test_voice_audio_pipeline.mjs, and that suite also executes the capture
 * worklet's source string against a stub. What neither can prove is that the
 * strings actually REGISTER and RUN inside a live AudioWorkletGlobalScope:
 * `registerProcessor`, `sampleRate`, `currentTime`, the `process()` contract,
 * and structured-clone of transferred ArrayBuffers across the port are all
 * browser-side behaviour a Node stub cannot model.
 *
 * So this runs both worklets inside headless Chromium with a real AudioContext,
 * driven by an OfflineAudioContext-independent live graph, and asserts on the
 * audio that actually comes out.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// AudioWorklet requires a secure context. about:blank is not one, so the test
// page is served from 127.0.0.1, which the browser treats as trustworthy.
const PORT = 4187;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let browser;
let page;
let server;

/** Pull the worklet source strings out of the TS modules without a bundler. */
async function readWorkletSources() {
  const capture = await readFile('frontend/src/voice/audio/capture.ts', 'utf8');
  const playback = await readFile('frontend/src/voice/audio/playbackWorklet.ts', 'utf8');

  // Trailing newline is optional and may be CRLF: these files get rewritten by
  // tooling on Windows, and a regex that demands "\n" then silently finds no
  // worklet source is a confusing way to fail.
  const captureMatch = capture.match(/const WORKLET_SOURCE = `([\s\S]*?)`;/);
  assert.ok(captureMatch, 'capture worklet source not found');

  const playbackMatch = playback.match(/export const PLAYBACK_WORKLET_SOURCE = `([\s\S]*?)`;/);
  assert.ok(playbackMatch, 'playback worklet source not found');

  // Both templates interpolate constants. Resolve them the same way esbuild would.
  const constants = {
    '${CAPTURE_TAPS}': '64',
    '${CAPTURE_CUTOFF_HZ}': '7600',
    '${MODEL_RATE}': '24000',
    '${LIMITER_KNEE}': '0.86',
    '${JITTER_MIN_MS}': '70',
    "${PLAYBACK_PROCESSOR}": 'mindpal-pcm-playback',
  };
  const resolve = (source) =>
    Object.entries(constants).reduce(
      (acc, [token, value]) => acc.split(token).join(value),
      source,
    );

  return { capture: resolve(captureMatch[1]), playback: resolve(playbackMatch[1]) };
}

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>worklet harness</title>');
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  browser = await chromium.launch({
    args: [
      // Deterministic silent input so getUserMedia is not needed, and autoplay
      // restrictions do not block the context.
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  page = await browser.newPage();
  await page.goto(BASE_URL);
  const secure = await page.evaluate(
    () => window.isSecureContext && typeof AudioWorklet !== 'undefined',
  );
  assert.ok(secure, 'AudioWorklet needs a secure context; the harness origin is wrong');
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test('capture worklet registers and decimates inside a real AudioWorkletGlobalScope', async () => {
  const { capture } = await readWorkletSources();

  const result = await page.evaluate(async (source) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-capture');
    const frames = [];
    node.port.onmessage = (event) => frames.push(event.data);

    // A 12 kHz tone: above the 8 kHz output Nyquist, so unfiltered decimation
    // would fold it onto 4 kHz at full amplitude.
    const osc = ctx.createOscillator();
    osc.frequency.value = 12000;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    osc.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    osc.start();

    await new Promise((r) => setTimeout(r, 700));
    osc.stop();

    const samples = [];
    for (const frame of frames) {
      const pcm = new Int16Array(frame.pcm);
      for (let i = 0; i < pcm.length; i += 1) samples.push(pcm[i] / 0x8000);
    }
    await ctx.close();

    // Goertzel at the alias frequency, skipping filter warm-up.
    const tail = samples.slice(1600);
    const mag = (hz, rate) => {
      const w = (2 * Math.PI * hz) / rate;
      const coeff = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (const x of tail) {
        const s = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (tail.length / 2);
    };
    let peak = 0;
    for (const x of tail) peak = Math.max(peak, Math.abs(x));

    return {
      frameCount: frames.length,
      sampleCount: samples.length,
      frameSize: frames.length ? new Int16Array(frames[0].pcm).length : 0,
      rmsReported: frames.length ? frames[0].rms : null,
      aliasAt4k: mag(4000, 16000),
      peak,
    };
  }, capture);

  assert.ok(result.frameCount > 10, `worklet must emit frames, got ${result.frameCount}`);
  assert.equal(result.frameSize, 320, 'frames must be the 320-sample / 20ms Live frame');
  assert.equal(typeof result.rmsReported, 'number', 'each frame reports rms for the energy path');

  // ~700ms of 48k input decimated to 16k is ~11k samples.
  assert.ok(
    result.sampleCount > 8000 && result.sampleCount < 13000,
    `decimation ratio wrong: ${result.sampleCount} samples for ~700ms at 16k`,
  );

  // The headline: a 12 kHz tone must not appear at 4 kHz.
  assert.ok(
    result.aliasAt4k < 0.02,
    `12kHz must not alias into the speech band, got ${result.aliasAt4k} at 4kHz`,
  );
  assert.ok(result.peak < 0.05, `stopband tone should be near-silent, peak ${result.peak}`);
});

test('playback worklet registers and streams PCM through a real AudioContext', async () => {
  const { playback } = await readWorkletSources();

  const result = await page.evaluate(async (source) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const messages = [];
    node.port.onmessage = (event) => messages.push(event.data);

    // Capture what the node actually outputs, rather than trusting its own report.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);

    // 24 kHz source material, sent in 480-sample (20ms) chunks like the provider.
    const RATE = 24000;
    const CHUNKS = 40;
    for (let c = 0; c < CHUNKS; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < chunk.length; i += 1) {
        const n = c * 480 + i;
        chunk[i] = Math.sin((2 * Math.PI * 440 * n) / RATE) * 0.5;
      }
      node.port.postMessage({ type: 'pcm', generation: 0, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });

    // Let it prebuffer and play out, sampling the analyser mid-stream.
    await new Promise((r) => setTimeout(r, 250));
    const freq = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freq);
    const binHz = ctx.sampleRate / analyser.fftSize;
    let peakBin = 0;
    for (let i = 1; i < freq.length; i += 1) if (freq[i] > freq[peakBin]) peakBin = i;
    const peakHz = peakBin * binHz;
    const peakDb = freq[peakBin];

    await new Promise((r) => setTimeout(r, 700));

    // Flush must empty the ring: nothing of the cut turn may survive.
    node.port.postMessage({ type: 'clear', generation: 1 });
    await new Promise((r) => setTimeout(r, 120));
    const afterClear = messages.filter((m) => m.type === 'stats').slice(-1)[0];

    // A stale-generation chunk must be ignored outright.
    const stale = new Float32Array(480);
    stale.fill(0.4);
    node.port.postMessage({ type: 'pcm', generation: 0, samples: stale.buffer }, [stale.buffer]);
    await new Promise((r) => setTimeout(r, 120));
    const afterStale = messages.filter((m) => m.type === 'stats').slice(-1)[0];

    await ctx.close();
    return {
      types: [...new Set(messages.map((m) => m.type))],
      drained: messages.some((m) => m.type === 'drained'),
      underruns: messages.filter((m) => m.type === 'underrun').length,
      reportedRate: (messages.find((m) => m.type === 'stats') || {}).rate,
      peakHz,
      peakDb,
      queuedAfterClear: afterClear ? afterClear.queued : null,
      queuedAfterStale: afterStale ? afterStale.queued : null,
    };
  }, playback);

  assert.ok(result.types.includes('stats'), `worklet must report stats, saw ${result.types}`);
  assert.equal(result.reportedRate, 48000, 'worklet must see the real device rate');

  // Resampled 24k -> 48k, a 440 Hz tone must still be 440 Hz.
  assert.ok(
    Math.abs(result.peakHz - 440) < 40,
    `440Hz at 24k must resample to 440Hz at 48k, got ${result.peakHz.toFixed(0)}Hz`,
  );
  assert.ok(result.peakDb > -60, `tone must actually be audible, peak ${result.peakDb}dB`);

  assert.equal(result.queuedAfterClear, 0, 'clear must empty the ring for the cut turn');
  assert.equal(
    result.queuedAfterStale,
    0,
    'a chunk stamped with the old generation must be dropped, not played',
  );
});

test('playback worklet reports starvation so the jitter target can widen', async () => {
  const { playback } = await readWorkletSources();

  const underruns = await page.evaluate(async (source) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    let count = 0;
    node.port.onmessage = (event) => {
      if (event.data.type === 'underrun') count += 1;
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(ctx.destination);

    // Deliberately starve it: hand over less than one render quantum, then start.
    node.port.postMessage({ type: 'prebuffer', ms: 0 });
    const tiny = new Float32Array(40);
    tiny.fill(0.2);
    node.port.postMessage({ type: 'pcm', generation: 0, samples: tiny.buffer }, [tiny.buffer]);
    node.port.postMessage({ type: 'start' });
    await new Promise((r) => setTimeout(r, 300));
    await ctx.close();
    return count;
  }, playback);

  assert.ok(underruns > 0, 'a starved quantum must be reported so JitterTarget can react');
});

test('barge-in tapers instead of cutting, and empties the cut turn', async () => {
  const { playback } = await readWorkletSources();

  const result = await page.evaluate(async (source) => {
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(ctx.destination);

    for (let c = 0; c < 50; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < 480; i += 1) {
        chunk[i] = Math.sin((2 * Math.PI * 300 * (c * 480 + i)) / 24000) * 0.6;
      }
      node.port.postMessage({ type: 'pcm', generation: 0, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });
    node.port.postMessage({ type: 'fade', ms: 180, generation: 1 });

    const data = (await ctx.startRendering()).getChannelData(0);
    const win = 240; // 5 ms
    const env = [];
    for (let i = 0; i + win < data.length; i += win) {
      let peak = 0;
      for (let k = 0; k < win; k += 1) peak = Math.max(peak, Math.abs(data[i + k]));
      env.push(peak);
    }
    const silentAt = env.findIndex((v) => v < 0.005);
    const end = silentAt < 0 ? env.length : silentAt;
    // Measure the taper from where it actually begins, not from sample zero.
    // The `fade` port message can be delivered a render quantum later under
    // load, which shifts the whole ramp and has nothing to do with its shape.
    const plateau = Math.max(...env.slice(0, end), 0);
    let fadeStart = 0;
    for (let i = end - 1; i >= 0; i -= 1) {
      if (env[i] >= plateau * 0.9) {
        fadeStart = i;
        break;
      }
    }
    let maxDrop = 0;
    for (let i = fadeStart + 1; i < end; i += 1) {
      maxDrop = Math.max(maxDrop, env[i - 1] - env[i]);
    }
    let tailPeak = 0;
    for (let i = (silentAt + 2) * win; i < data.length; i += 1) {
      tailPeak = Math.max(tailPeak, Math.abs(data[i]));
    }
    return { silentMs: (end - fadeStart) * 5, startedAtMs: fadeStart * 5, maxDrop, tailPeak };
  }, playback);

  // A caller described the old 48ms ramp as stopping "with no fade". The taper
  // has to be long enough to hear as yielding.
  assert.ok(
    result.silentMs >= 120 && result.silentMs <= 260,
    `taper should last about 180ms, got ${result.silentMs}ms (began at ${result.startedAtMs}ms)`,
  );
  assert.ok(
    result.maxDrop < 0.05,
    `no step may read as a cut, steepest was ${result.maxDrop.toFixed(3)} per 5ms`,
  );
  // The old main-thread fade raced the async clear and let the cut sentence
  // burst back at full volume. The node owns both now, so nothing survives.
  assert.ok(result.tailPeak < 0.01, `cut turn must not resume, peak ${result.tailPeak}`);
});

test('releasing barge-in fence mid-fade switches to the new generation without dropping subsequent audio', async () => {
  const { playback } = await readWorkletSources();

  const result = await page.evaluate(async (source) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const messages = [];
    node.port.onmessage = (event) => messages.push(event.data);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);

    // 1. Initial turn: 20 chunks tagged generation: 0
    for (let c = 0; c < 20; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < chunk.length; i += 1) {
        chunk[i] = Math.sin((2 * Math.PI * 440 * (c * 480 + i)) / 24000) * 0.5;
      }
      node.port.postMessage({ type: 'pcm', generation: 0, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });

    await new Promise((r) => setTimeout(r, 60));

    // 2. User interrupts: flush sends fade with generation: 1
    node.port.postMessage({ type: 'fade', ms: 180, generation: 1 });

    // 3. 5ms later: Gemini turn_complete arrives, releaseFence sends generation: 2
    await new Promise((r) => setTimeout(r, 5));
    node.port.postMessage({ type: 'generation', generation: 2 });

    // 4. Wait past the original 180ms fade period (e.g. 220ms)
    // In the buggy code, the fade completion would have overwritten generation back to 1.
    await new Promise((r) => setTimeout(r, 220));

    // 5. Next reply arrives with generation: 2 (880Hz tone)
    for (let c = 0; c < 20; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < chunk.length; i += 1) {
        chunk[i] = Math.sin((2 * Math.PI * 880 * (c * 480 + i)) / 24000) * 0.5;
      }
      node.port.postMessage({ type: 'pcm', generation: 2, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });

    await new Promise((r) => setTimeout(r, 150));

    // Sample the analyser to verify the 880 Hz tone is playing
    const freq = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freq);
    const binHz = ctx.sampleRate / analyser.fftSize;
    let peakBin = 0;
    for (let i = 1; i < freq.length; i += 1) if (freq[i] > freq[peakBin]) peakBin = i;
    const peakHz = peakBin * binHz;
    const peakDb = freq[peakBin];

    const stats = messages.filter((m) => m.type === 'stats').slice(-1)[0];

    await ctx.close();
    return {
      peakHz,
      peakDb,
      queued: stats ? stats.queued : null,
    };
  }, playback);

  assert.ok(
    Math.abs(result.peakHz - 880) < 50,
    `880Hz next reply must play, got peak at ${result.peakHz.toFixed(0)}Hz`,
  );
  assert.ok(result.peakDb > -60, `tone must actually be audible, peak ${result.peakDb}dB`);
  assert.ok(result.queued !== null && result.queued >= 0, 'worklet must still report stats');
});

test('early arrival of next reply audio mid-fade is not wiped or attenuated', async () => {
  const { playback } = await readWorkletSources();

  const result = await page.evaluate(async (source) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, 'mindpal-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);

    // Initial turn: 20 chunks tagged generation: 0
    for (let c = 0; c < 20; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < chunk.length; i += 1) {
        chunk[i] = Math.sin((2 * Math.PI * 440 * (c * 480 + i)) / 24000) * 0.5;
      }
      node.port.postMessage({ type: 'pcm', generation: 0, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });

    await new Promise((r) => setTimeout(r, 60));

    // User interrupts: flush sends fade with generation: 1
    node.port.postMessage({ type: 'fade', ms: 180, generation: 1 });

    // 5ms later: Gemini turn_complete arrives, releaseFence sends generation: 2
    await new Promise((r) => setTimeout(r, 5));
    node.port.postMessage({ type: 'generation', generation: 2 });

    // 10ms later (well inside the original 180ms fade window): new reply arrives
    await new Promise((r) => setTimeout(r, 10));
    for (let c = 0; c < 30; c += 1) {
      const chunk = new Float32Array(480);
      for (let i = 0; i < chunk.length; i += 1) {
        chunk[i] = Math.sin((2 * Math.PI * 660 * (c * 480 + i)) / 24000) * 0.5;
      }
      node.port.postMessage({ type: 'pcm', generation: 2, samples: chunk.buffer }, [chunk.buffer]);
    }
    node.port.postMessage({ type: 'start' });

    // Wait until 250ms has elapsed total (so 180ms fade would have expired)
    await new Promise((r) => setTimeout(r, 220));

    // Sample the analyser to verify the 660 Hz tone survived and is playing at full volume
    const freq = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freq);
    const binHz = ctx.sampleRate / analyser.fftSize;
    let peakBin = 0;
    for (let i = 1; i < freq.length; i += 1) if (freq[i] > freq[peakBin]) peakBin = i;
    const peakHz = peakBin * binHz;
    const peakDb = freq[peakBin];

    await ctx.close();
    return { peakHz, peakDb };
  }, playback);

  assert.ok(
    Math.abs(result.peakHz - 660) < 50,
    `660Hz early next reply must play through fade expiration, got peak at ${result.peakHz.toFixed(0)}Hz`,
  );
  assert.ok(result.peakDb > -60, `tone must be audible, peak ${result.peakDb}dB`);
});

