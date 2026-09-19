/**
 * Adaptive speech energy for the face. Loud and quiet talkers both land in 0..1.
 * Not an emotion score.
 */

export const ENERGY_REF = 0.11;
export const ENERGY_KNEE = 0.82;
export const ENERGY_WINDOW = 80;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Soft-knee compressor. Peaks fold instead of clipping past 1. */
export function softKnee(value: number, limit = 1): number {
  if (!Number.isFinite(value) || limit <= 0) return 0;
  return limit * Math.tanh(value / limit);
}

/** Map raw RMS into 0..1 using a rolling reference, not a fixed ×12 gain. */
export function compressEnergy(rms: number, ref = ENERGY_REF): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const x = rms / Math.max(0.018, ref);
  return clamp01(Math.tanh(x * ENERGY_KNEE));
}

export class EnergyNormalizer {
  private samples: number[] = [];
  private p95 = ENERGY_REF;
  readonly window: number;

  constructor(window = ENERGY_WINDOW) {
    this.window = Math.max(12, window);
  }

  get reference(): number {
    return this.p95;
  }

  push(rms: number): number {
    const energy = Math.max(0, Number.isFinite(rms) ? rms : 0);
    this.samples.push(energy);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length >= 8) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      this.p95 = Math.max(0.02, sorted[idx] || ENERGY_REF);
    }
    return compressEnergy(energy, this.p95);
  }
}

/** Attack/release envelope so raw RMS never drives geometry. */
export class EnvelopeFollower {
  value = 0;
  private attack: number;
  private release: number;

  constructor(attack = 0.38, release = 0.14) {
    this.attack = attack;
    this.release = release;
  }

  push(target: number, dtMs = 16.67): number {
    const scale = Math.min(3, Math.max(0.25, dtMs / 16.67));
    const want = clamp01(target);
    const coeff = (want > this.value ? this.attack : this.release) * scale;
    this.value += (want - this.value) * Math.min(1, coeff);
    return this.value;
  }

  snap(value: number): number {
    this.value = clamp01(value);
    return this.value;
  }
}
