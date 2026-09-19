/**
 * Acoustic descriptors from capture PCM. Not affect, not a clinical score.
 * Runs on the main thread after frames leave the AudioWorklet (~0.1ms / 20ms frame).
 */

export type ProsodyState = 'energetic' | 'steady' | 'flattening' | 'quiet' | 'agitated';

export interface ProsodySnapshot {
  state: ProsodyState;
  energy: number;
  shortLong: number;
  f0Hz: number;
  f0Var: number;
  f0Slope: number;
  onsetHz: number;
  sinceOnsetMs: number;
  turnMs: number;
  voiced: boolean;
}

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const SHORT_MS = 250;
const LONG_MS = 4000;
const F0_WINDOW = 48;
const ONSET_WINDOW = 100;
const TAU_MIN_HZ = 400;
const TAU_MAX_HZ = 70;

export function estimateF0Hz(pcm: Int16Array, sampleRate = SAMPLE_RATE): number {
  const n = pcm.length;
  if (n < 80) return 0;
  const samples = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = pcm[i] / 0x8000;
    samples[i] = x;
    energy += x * x;
  }
  if (energy / n < 8e-5) return 0;
  const tauMin = Math.max(2, Math.floor(sampleRate / TAU_MIN_HZ));
  const tauMax = Math.min(n - 3, Math.floor(sampleRate / TAU_MAX_HZ));
  if (tauMax <= tauMin) return 0;
  const diff = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    let sum = 0;
    const limit = n - tau;
    for (let i = 0; i < limit; i += 1) {
      const d = samples[i] - samples[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  let running = 0;
  let bestTau = 0;
  let best = 1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    running += diff[tau];
    const cmnd = (diff[tau] * (tau - tauMin + 1)) / Math.max(running, 1e-12);
    if (cmnd < best) {
      best = cmnd;
      bestTau = tau;
    }
    if (best < 0.12 && cmnd > best + 0.04) break;
  }
  if (bestTau === 0 || best > 0.28) return 0;
  return sampleRate / bestTau;
}

export class ProsodyTracker {
  private short = 0;
  private long = 0.08;
  private prevRms = 0;
  private turnStart = 0;
  private lastVoice = 0;
  private lastState: ProsodyState = 'quiet';
  private f0s: number[] = [];
  private onsets: number[] = [];
  private lastOnset = 0;

  /** Pitch and onsets from the last turn must not manufacture agitation in this one. */
  private resetTurnWindows(seedF0: number, now: number): void {
    this.f0s = seedF0 > 0 ? [seedF0] : [];
    this.onsets = this.onsets.filter((stamp) => stamp >= now);
    this.lastOnset = this.onsets.length ? now : 0;
  }

  push(pcm: Int16Array, rms: number, now = Date.now()): ProsodySnapshot {
    const energy = Math.min(1, Math.max(0, rms));
    const shortC = 1 - Math.exp(-FRAME_MS / SHORT_MS);
    const longC = 1 - Math.exp(-FRAME_MS / LONG_MS);
    this.short += (energy - this.short) * shortC;
    this.long += (energy - this.long) * longC;
    const shortLong = this.short / Math.max(this.long, 0.02);
    const voiced = energy > 0.045;
    const f0 = voiced ? estimateF0Hz(pcm) : 0;
    if (f0 > 0) {
      this.f0s.push(f0);
      if (this.f0s.length > F0_WINDOW) this.f0s.shift();
    }
    if (energy > 0.12 && energy - this.prevRms > 0.07 && now - this.lastOnset > 70) {
      this.onsets.push(now);
      this.lastOnset = now;
    }
    this.prevRms = energy;
    this.onsets = this.onsets.filter((stamp) => now - stamp < ONSET_WINDOW * FRAME_MS);
    if (voiced) {
      if (!this.turnStart || now - this.lastVoice > 900) {
        this.turnStart = now;
        this.resetTurnWindows(f0, now);
      }
      this.lastVoice = now;
    } else if (now - this.lastVoice > 900 && this.turnStart) {
      this.turnStart = 0;
      this.resetTurnWindows(0, now);
    }
    const turnMs = this.turnStart ? now - this.turnStart : 0;
    const f0Var = variance(this.f0s);
    const onsetHz = this.onsets.length / Math.max(0.4, Math.min(2, turnMs / 1000 || 2));
    const medianF0 = median(this.f0s);
    const slopeWindow = Math.min(8, this.f0s.length);
    const f0Slope =
      slopeWindow >= 4 ? this.f0s[this.f0s.length - 1] - this.f0s[this.f0s.length - slopeWindow] : 0;
    const sinceOnsetMs = this.lastOnset ? now - this.lastOnset : 9999;
    const rising = this.f0s.length >= 6 && this.f0s[this.f0s.length - 1] > this.f0s[0] + 12;
    const state = this.classify({ energy, shortLong, f0Var, onsetHz, turnMs, voiced, rising, medianF0 });
    this.lastState = state;
    return {
      state,
      energy: this.short,
      shortLong,
      f0Hz: medianF0,
      f0Var,
      f0Slope,
      onsetHz,
      sinceOnsetMs,
      turnMs,
      voiced,
    };
  }

  private classify(input: {
    energy: number;
    shortLong: number;
    f0Var: number;
    onsetHz: number;
    turnMs: number;
    voiced: boolean;
    rising: boolean;
    medianF0: number;
  }): ProsodyState {
    if (this.lastState === 'flattening' && input.shortLong > 1.55 && input.energy > 0.22) {
      return 'energetic';
    }
    if (!input.voiced && input.energy < 0.08) return 'quiet';
    if (input.energy > 0.42 && input.onsetHz > 3.2 && input.rising) return 'agitated';
    const lively = (input.energy > 0.3 ? 1 : 0) + (input.f0Var > 10 ? 1 : 0) + (input.onsetHz > 2 ? 1 : 0);
    if (lively >= 2 && input.energy > 0.24 && input.turnMs > 300) return 'energetic';
    if (
      input.turnMs > 7000 &&
      input.f0Var < 9 &&
      input.shortLong < 0.88 &&
      input.energy < 0.38
    ) {
      return 'flattening';
    }
    if (input.voiced) return 'steady';
    return 'quiet';
  }
}

export function isQuietDistress(snapshot: ProsodySnapshot): boolean {
  return snapshot.energy < 0.16 && snapshot.onsetHz < 1.15 && snapshot.turnMs > 1600;
}

function variance(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sum = values.reduce((acc, value) => acc + (value - mean) ** 2, 0);
  return Math.sqrt(sum / values.length);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
