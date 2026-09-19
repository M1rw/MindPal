import { JITTER_MIN_MS, LIMITER_KNEE, MODEL_RATE } from './playbackCore.ts';

export const PLAYBACK_PROCESSOR = 'mindpal-pcm-playback';

/**
 * Playback worklet source.
 *
 * Mirrors `playbackCore.ts` — a worklet runs in its own realm and cannot import,
 * so the maths is duplicated and a contract test pins the two implementations
 * together by running the same signal through both.
 *
 * One node, one ring, one resampler for the life of the call. That is the whole
 * point: the per-chunk `AudioBufferSourceNode` path it replaces restarted its
 * resampler at every provider chunk, which put a discontinuity into the stream
 * fifty times a second.
 */
export const PLAYBACK_WORKLET_SOURCE = `
const MODEL_RATE = ${MODEL_RATE};
const LIMITER_KNEE = ${LIMITER_KNEE};
const MIN_PREBUFFER_MS = ${JITTER_MIN_MS};
const STATS_EVERY = 8;

function softLimit(x) {
  if (x > LIMITER_KNEE) return LIMITER_KNEE + (1 - LIMITER_KNEE) * Math.tanh((x - LIMITER_KNEE) / (1 - LIMITER_KNEE));
  if (x < -LIMITER_KNEE) return -LIMITER_KNEE - (1 - LIMITER_KNEE) * Math.tanh((-x - LIMITER_KNEE) / (1 - LIMITER_KNEE));
  return x;
}

class MindPalPcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 12 s. The main thread applies flow control so this should never fill, but
    // the model generates far faster than real time and an overrun here drops
    // audio mid-sentence - which sounds like the speech compressing and bursting.
    this._ring = new Float32Array(Math.ceil(sampleRate * 12));
    this._read = 0;
    this._write = 0;
    this._count = 0;
    this._step = MODEL_RATE / sampleRate;
    this._phase = 0;
    this._last = 0;
    this._primed = false;
    this._started = false;
    this._prebufferSamples = Math.ceil((MIN_PREBUFFER_MS / 1000) * sampleRate);
    this._ticks = 0;
    this._wasDraining = false;
    this._overflow = 0;
    // Sample-accurate barge-in taper. Doing this on the main thread via a
    // GainNode raced the async 'clear' message: the gain was restored to 1
    // before the audio thread had emptied the ring, so the cut sentence burst
    // back at full volume for a quantum. Owning the fade here removes the race
    // and lets the ramp land exactly on the samples being discarded.
    this._fadeTotal = 0;
    this._fadeLeft = 0;
    this._generation = 0;
    this._pendingGeneration = undefined;
    this.port.onmessage = (event) => this._onMessage(event.data);
  }

  _clearRing() {
    this._read = 0;
    this._write = 0;
    this._count = 0;
    this._phase = 0;
    this._last = 0;
    this._primed = false;
    this._started = false;
  }

  _abortFade() {
    this._fadeTotal = 0;
    this._fadeLeft = 0;
    this._pendingGeneration = undefined;
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'pcm') {
      if (msg.generation !== undefined) {
        if (msg.generation < this._generation) return;
        if (msg.generation > this._generation || this._fadeTotal > 0) {
          this._generation = Math.max(this._generation, msg.generation);
          this._abortFade();
          this._clearRing();
        }
      } else if (this._fadeTotal > 0) {
        this._abortFade();
        this._clearRing();
      }
      this._pushResampled(new Float32Array(msg.samples));
      return;
    }
    if (msg.type === 'clear') {
      this._abortFade();
      this._clearRing();
      if (msg.generation !== undefined) {
        this._generation = Math.max(this._generation, msg.generation);
      }
      return;
    }
    if (msg.type === 'generation') {
      if (msg.generation !== undefined) {
        if (msg.generation < this._generation) return;
        this._generation = msg.generation;
      }
      this._pendingGeneration = undefined;
      // Fade is allowed to continue playing smoothly to completion.
      // It is only aborted if new audio arrives or if explicitly cleared.
      return;
    }
    if (msg.type === 'prebuffer') {
      this._prebufferSamples = Math.max(0, Math.ceil((msg.ms / 1000) * sampleRate));
      return;
    }
    if (msg.type === 'fade') {
      if (msg.generation !== undefined && msg.generation < this._generation) return;
      const ms = Math.max(10, Number(msg.ms) || 0);
      this._fadeTotal = Math.ceil((ms / 1000) * sampleRate);
      this._fadeLeft = this._fadeTotal;
      if (msg.generation !== undefined) {
        this._pendingGeneration = Math.max(this._generation, msg.generation);
      }
      return;
    }
    if (msg.type === 'start') {
      this._started = true;
    }
  }

  // Resample 24k -> device rate with carried phase, then write into the ring.
  _pushResampled(input) {
    if (!input.length) return;
    if (!this._primed) { this._last = input[0]; this._primed = true; }
    const cap = this._ring.length;
    let phase = this._phase;
    while (phase < input.length) {
      const base = Math.floor(phase);
      const frac = phase - base;
      const a = base === 0 ? this._last : input[base - 1];
      const b = input[base];
      const value = a + (b - a) * frac;
      if (this._count === cap) {
        // Should be unreachable with flow control. Drop the NEWEST sample rather
        // than the oldest: losing the tail of a sentence is recoverable, losing
        // the middle of one is the compress-and-burst artefact.
        this._overflow += 1;
        break;
      }
      this._ring[this._write] = value;
      this._write = (this._write + 1) % cap;
      this._count += 1;
      phase += this._step;
    }
    this._last = input[input.length - 1];
    this._phase = phase - input.length;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const channel = output[0];
    const frames = channel.length;
    const cap = this._ring.length;

    if (!this._started && this._count < this._prebufferSamples) {
      channel.fill(0);
      this._report(false);
      return true;
    }
    this._started = true;

    const take = Math.min(frames, this._count);
    for (let i = 0; i < take; i++) {
      let sample = this._ring[this._read];
      if (this._fadeLeft > 0) {
        // Equal-power taper: cos^2 to zero. Trails off the way a person does
        // when interrupted, instead of cutting mid-syllable.
        const t = 1 - this._fadeLeft / this._fadeTotal;
        const cosine = Math.cos((Math.PI / 2) * t);
        sample *= cosine * cosine;
        this._fadeLeft -= 1;
      } else if (this._fadeTotal > 0) {
        sample = 0;
      }
      channel[i] = softLimit(sample);
      this._read = (this._read + 1) % cap;
    }
    this._count -= take;
    for (let i = take; i < frames; i++) channel[i] = 0;

    // Fade finished: drop the rest of the cut turn and tell the main thread.
    if (this._fadeTotal > 0 && this._fadeLeft <= 0) {
      const nextGen = this._pendingGeneration;
      this._abortFade();
      this._clearRing();
      if (nextGen !== undefined && nextGen > this._generation) {
        this._generation = nextGen;
      }
      this.port.postMessage({ type: 'faded' });
      this._report(false);
      return true;
    }

    // A short stream ending cleanly is not an underrun; only a starved quantum
    // while we believed we were mid-stream is. Fading out is intentional, not an underrun.
    const starved = this._fadeTotal === 0 && take < frames && take > 0;
    if (this._count === 0) {
      this._started = false;
      this._phase = 0;
      this._primed = false;
    }
    this._report(starved);
    for (let c = 1; c < output.length; c++) output[c].set(channel);
    return true;
  }

  _report(starved) {
    this._ticks += 1;
    const draining = this._count === 0 && !this._started;
    if (draining && !this._wasDraining) {
      this._wasDraining = true;
      this.port.postMessage({ type: 'drained' });
    } else if (!draining) {
      this._wasDraining = false;
    }
    if (starved) this.port.postMessage({ type: 'underrun' });
    if (this._ticks % STATS_EVERY === 0) {
      this.port.postMessage({
        type: 'stats',
        queued: this._count,
        queuedMs: (this._count / sampleRate) * 1000,
        overflow: this._overflow,
        rate: sampleRate,
      });
    }
  }
}
registerProcessor('${PLAYBACK_PROCESSOR}', MindPalPcmPlaybackProcessor);
`;
