/**
 * Anti-aliased decimation to the 16 kHz Live capture rate.
 *
 * The previous capture worklet kept every Nth sample with no lowpass, so on a
 * 48 kHz device everything from 8 kHz to 24 kHz folded back into the speech band.
 * That is audible as grit on sibilants, and it is worse than cosmetic: the folded
 * energy lands where `estimateF0Hz` looks for pitch and where the provider's ASR
 * reads formants.
 *
 * Design: a windowed-sinc polyphase FIR evaluated only at output positions, so
 * the cost is `taps` multiply-adds per OUTPUT sample rather than per input
 * sample. At 48 k -> 16 k that is 3x cheaper than filtering then dropping.
 *
 * Kept dependency-free and pure so it is unit-testable off the audio thread; the
 * worklet inlines a copy of the same maths.
 */

/** Stopband starts here. Below Nyquist(16k)=8k, with room for the transition. */
export const CAPTURE_CUTOFF_HZ = 7600;
/**
 * 64 taps. Measured on a 48 kHz input: -0.1 dB at 6 kHz (speech band intact),
 * -34 dB at 9 kHz and -79 dB at 10 kHz, for 0.67 ms of group delay and about
 * 1M multiply-adds/second. 96 taps buys another 40 dB at 9 kHz but costs a
 * full millisecond of added mouth-to-model latency, which this system spends
 * better elsewhere.
 */
export const CAPTURE_TAPS = 64;

/**
 * Windowed-sinc lowpass, normalised to unity DC gain.
 * `cutoffRatio` is the cutoff as a fraction of the INPUT sample rate.
 */
export function designLowpass(taps: number, cutoffRatio: number): Float32Array {
  const n = Math.max(2, Math.floor(taps));
  const fc = Math.min(0.49, Math.max(1e-4, cutoffRatio));
  const kernel = new Float32Array(n);
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i - mid;
    // sinc(2*fc*x)
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    // Blackman window: -58 dB sidelobes, the right trade for speech.
    const t = (2 * Math.PI * i) / (n - 1);
    const window = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
    const value = sinc * window;
    kernel[i] = value;
    sum += value;
  }
  if (sum !== 0) {
    for (let i = 0; i < n; i += 1) kernel[i] /= sum;
  }
  return kernel;
}

/**
 * Streaming fractional decimator. Holds `taps - 1` input samples between calls so
 * block boundaries are continuous — a per-block filter would click every 128
 * samples, which is exactly the artefact this is meant to remove.
 */
export class Decimator {
  readonly ratio: number;
  private kernel: Float32Array;
  private history: Float32Array;
  /** Fractional read position inside `history`, in input samples. */
  private phase = 0;

  constructor(inputRate: number, outputRate = 16000, taps = CAPTURE_TAPS, cutoffHz = CAPTURE_CUTOFF_HZ) {
    const inRate = Number.isFinite(inputRate) && inputRate > 0 ? inputRate : outputRate;
    this.ratio = Math.max(1, inRate / outputRate);
    // Cutoff is bounded by the OUTPUT Nyquist; upsampling must not open the band.
    const effectiveCutoff = Math.min(cutoffHz, outputRate * 0.475);
    this.kernel = designLowpass(taps, effectiveCutoff / inRate);
    this.history = new Float32Array(this.kernel.length);
  }

  get taps(): number {
    return this.kernel.length;
  }

  /** Feed one input block, receive every output sample that became available. */
  process(input: Float32Array): Float32Array {
    const taps = this.kernel.length;
    const history = this.history;
    const total = history.length + input.length;
    // Scratch = carried history followed by this block.
    const buffer = new Float32Array(total);
    buffer.set(history, 0);
    buffer.set(input, history.length);

    const out: number[] = [];
    let phase = this.phase;
    // A full window ending at `pos` needs pos >= taps - 1.
    while (phase + taps - 1 < total) {
      const base = Math.floor(phase);
      const frac = phase - base;
      let acc = 0;
      if (frac === 0) {
        for (let k = 0; k < taps; k += 1) acc += this.kernel[k] * buffer[base + k];
      } else {
        // Linear interpolation between neighbouring input samples keeps a
        // non-integer ratio (44.1k -> 16k) free of periodic phase jitter.
        for (let k = 0; k < taps; k += 1) {
          const a = buffer[base + k];
          const b = base + k + 1 < total ? buffer[base + k + 1] : a;
          acc += this.kernel[k] * (a + (b - a) * frac);
        }
      }
      out.push(acc);
      phase += this.ratio;
    }

    // Retain the tail the next window will need, and rebase the phase onto it.
    const consumed = Math.max(0, Math.floor(phase) - (taps - 1));
    const keepFrom = Math.min(total, consumed);
    const tail = buffer.subarray(keepFrom);
    this.history = new Float32Array(tail.length);
    this.history.set(tail);
    this.phase = phase - keepFrom;

    const result = new Float32Array(out.length);
    for (let i = 0; i < out.length; i += 1) result[i] = out[i];
    return result;
  }

  reset(): void {
    this.history = new Float32Array(this.kernel.length);
    this.phase = 0;
  }
}

/** Clamp + convert to the Int16 the Live socket expects. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

/**
 * Attenuation the designed filter actually delivers at a given frequency.
 * Used by the contract test so the anti-alias claim is measured, not asserted.
 */
export function responseDb(kernel: Float32Array, freqHz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < kernel.length; i += 1) {
    re += kernel[i] * Math.cos(-w * i);
    im += kernel[i] * Math.sin(-w * i);
  }
  const mag = Math.sqrt(re * re + im * im);
  return 20 * Math.log10(Math.max(mag, 1e-12));
}
