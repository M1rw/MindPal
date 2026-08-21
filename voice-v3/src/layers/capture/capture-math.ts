/**
 * Pure DSP helpers shared by the AudioWorklet and deterministic tests.
 * This file must remain free of DOM, React, Web Audio, and main-thread state.
 */

export const TARGET_CAPTURE_SAMPLE_RATE = 16_000 as const;
export const CAPTURE_FRAME_DURATION_MS = 20 as const;
export const CAPTURE_FRAME_SAMPLES = 320 as const;

/**
 * Streaming linear resampler. It retains one source sample at the boundary so
 * adjacent AudioWorklet quanta do not create discontinuities or sample-rate
 * dependent VAD behavior.
 */
export class LinearDownsampler {
  private readonly ratio: number;
  private sourceBuffer: number[] = [];
  private sourcePosition = 0;

  public constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate = TARGET_CAPTURE_SAMPLE_RATE,
  ) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new RangeError("inputSampleRate must be positive");
    }
    if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
      throw new RangeError("outputSampleRate must be positive");
    }
    this.ratio = inputSampleRate / outputSampleRate;
  }

  public push(input: Float32Array | readonly number[]): Float32Array {
    for (let index = 0; index < input.length; index += 1) {
      const sample = Number(input[index]);
      this.sourceBuffer.push(Number.isFinite(sample) ? sample : 0);
    }

    const output: number[] = [];
    while (this.sourcePosition + 1 < this.sourceBuffer.length) {
      const baseIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - baseIndex;
      const first = this.sourceBuffer[baseIndex] ?? 0;
      const second = this.sourceBuffer[baseIndex + 1] ?? first;
      output.push(first + (second - first) * fraction);
      this.sourcePosition += this.ratio;
    }

    const consumed = Math.max(0, Math.floor(this.sourcePosition));
    if (consumed > 0) {
      this.sourceBuffer = this.sourceBuffer.slice(consumed);
      this.sourcePosition -= consumed;
    }

    return Float32Array.from(output);
  }

  public reset(): void {
    this.sourceBuffer = [];
    this.sourcePosition = 0;
  }
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
    pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return pcm;
}

export function calculateRms(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  const divisor = samples instanceof Int16Array ? 32768 : 1;
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = Number(samples[index]) / divisor;
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / samples.length);
}

export function createSilencePcm16(length = CAPTURE_FRAME_SAMPLES): Int16Array {
  return new Int16Array(length);
}
