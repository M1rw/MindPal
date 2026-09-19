/**
 * Pure playback DSP, shared by the main thread and the playback AudioWorklet.
 *
 * The previous playback path allocated one `AudioBufferSourceNode` per ~20 ms
 * provider chunk and scheduled it at `nextTime = startAt + buffer.duration`.
 * Two artefacts came out of that:
 *
 *  1. Each chunk was resampled 24 kHz -> device rate independently, so every
 *     chunk boundary had its own filter start-up transient — a faint tick 50
 *     times a second.
 *  2. `nextTime` accumulated float error against `context.currentTime`, so the
 *     stream slowly drifted and periodically produced a gap or an overlap.
 *
 * A single continuous stream fixes both: one resampler with carried state, one
 * ring buffer, one output node. This module is the part worth unit-testing, so
 * it holds no Web Audio references.
 */

/** Provider native-audio output rate. Fixed by Gemini Live. */
export const MODEL_RATE = 24000;

/**
 * Lock-free-ish single-producer/single-consumer ring of Float32 samples.
 * Overrun drops the oldest audio rather than the newest: if we are that far
 * behind, the stale audio is the part nobody wants to hear.
 */
export class AudioRing {
  private buffer: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private count = 0;
  private droppedSamples = 0;

  constructor(capacitySamples: number) {
    this.buffer = new Float32Array(Math.max(1024, Math.floor(capacitySamples)));
  }

  get capacity(): number {
    return this.buffer.length;
  }

  get length(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedSamples;
  }

  write(input: Float32Array): number {
    const cap = this.buffer.length;
    let written = 0;
    for (let i = 0; i < input.length; i += 1) {
      if (this.count === cap) {
        // Full: advance the read head, losing the oldest sample.
        this.readIndex = (this.readIndex + 1) % cap;
        this.count -= 1;
        this.droppedSamples += 1;
      }
      this.buffer[this.writeIndex] = input[i];
      this.writeIndex = (this.writeIndex + 1) % cap;
      this.count += 1;
      written += 1;
    }
    return written;
  }

  /** Fill `out` from the ring; any shortfall is written as silence. Returns samples read. */
  read(out: Float32Array): number {
    const cap = this.buffer.length;
    const take = Math.min(out.length, this.count);
    for (let i = 0; i < take; i += 1) {
      out[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % cap;
    }
    this.count -= take;
    for (let i = take; i < out.length; i += 1) out[i] = 0;
    return take;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
  }
}

/**
 * Continuous linear-interpolating resampler.
 *
 * Upsampling 24 k -> 48 k needs no anti-alias filter (no new content above the
 * source Nyquist), so linear interpolation is correct here and cheap. The point
 * is the carried `lastSample` and fractional `phase`: they make chunk boundaries
 * invisible, which is what the per-chunk AudioBuffer approach could not do.
 */
export class ContinuousResampler {
  readonly step: number;
  private phase = 0;
  private lastSample = 0;
  private primed = false;

  constructor(inputRate: number, outputRate: number) {
    const inRate = inputRate > 0 ? inputRate : outputRate;
    this.step = inRate / (outputRate > 0 ? outputRate : inRate);
  }

  /** Output samples this many input samples will yield, approximately. */
  expectedOutput(inputLength: number): number {
    return Math.floor(inputLength / this.step);
  }

  process(input: Float32Array): Float32Array {
    if (!input.length) return new Float32Array(0);
    if (!this.primed) {
      this.lastSample = input[0];
      this.primed = true;
    }
    const out: number[] = [];
    let phase = this.phase;
    while (phase < input.length) {
      const base = Math.floor(phase);
      const frac = phase - base;
      const a = base === 0 ? this.lastSample : input[base - 1];
      const b = input[base];
      out.push(a + (b - a) * frac);
      phase += this.step;
    }
    this.lastSample = input[input.length - 1];
    this.phase = phase - input.length;
    const result = new Float32Array(out.length);
    for (let i = 0; i < out.length; i += 1) result[i] = out[i];
    return result;
  }

  reset(): void {
    this.phase = 0;
    this.lastSample = 0;
    this.primed = false;
  }
}

/**
 * Adaptive jitter target.
 *
 * A fixed 70 ms prebuffer underruns on any network hiccup, and an underrun in a
 * continuous stream is an audible gap. This grows the target when starvation is
 * observed and decays it back when the stream has been clean, so a good network
 * keeps low latency and a bad one stops clicking.
 */
export const JITTER_MIN_MS = 70;
export const JITTER_MAX_MS = 260;
export const JITTER_GROWTH_MS = 45;
export const JITTER_DECAY_PER_CLEAN = 0.985;

export class JitterTarget {
  private targetMs: number;
  private cleanRuns = 0;

  constructor(initialMs = JITTER_MIN_MS) {
    this.targetMs = Math.min(JITTER_MAX_MS, Math.max(JITTER_MIN_MS, initialMs));
  }

  get valueMs(): number {
    return this.targetMs;
  }

  /** Report a starved render quantum. Widens the buffer. */
  noteUnderrun(): number {
    this.cleanRuns = 0;
    this.targetMs = Math.min(JITTER_MAX_MS, this.targetMs + JITTER_GROWTH_MS);
    return this.targetMs;
  }

  /** Report a clean render quantum. Slowly returns toward the floor. */
  noteClean(): number {
    this.cleanRuns += 1;
    if (this.cleanRuns > 20) {
      this.targetMs = Math.max(JITTER_MIN_MS, this.targetMs * JITTER_DECAY_PER_CLEAN);
    }
    return this.targetMs;
  }

  samplesFor(rate: number): number {
    return Math.ceil((this.targetMs / 1000) * rate);
  }

  reset(): void {
    this.targetMs = JITTER_MIN_MS;
    this.cleanRuns = 0;
  }
}

export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 0x8000;
  return out;
}

/**
 * Soft limiter on the output bus. tanh above the knee keeps a loud native-audio
 * peak from clipping into the hard-edged distortion that reads as "cheap".
 */
export const LIMITER_KNEE = 0.86;

export function softLimit(sample: number): number {
  const x = sample;
  if (x > LIMITER_KNEE) {
    return LIMITER_KNEE + (1 - LIMITER_KNEE) * Math.tanh((x - LIMITER_KNEE) / (1 - LIMITER_KNEE));
  }
  if (x < -LIMITER_KNEE) {
    return -LIMITER_KNEE - (1 - LIMITER_KNEE) * Math.tanh((-x - LIMITER_KNEE) / (1 - LIMITER_KNEE));
  }
  return x;
}
