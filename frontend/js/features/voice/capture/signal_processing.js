export const CAPTURE_SAMPLE_RATE_HZ = 16000;
export const CAPTURE_FRAME_DURATION_MS = 20;
export const CAPTURE_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE_HZ / 1000) * CAPTURE_FRAME_DURATION_MS;
export const MAX_SAMPLES_PER_PUSH = 32000;

export function resampleMonoTo16k(samples, inputSampleRateHz) {
  const source = normalizeSamples(samples);
  const rate = validateSampleRate(inputSampleRateHz);
  if (source.length === 0) return new Float32Array(0);
  if (rate === CAPTURE_SAMPLE_RATE_HZ) return new Float32Array(source);

  const outputLength = Math.floor((source.length * CAPTURE_SAMPLE_RATE_HZ) / rate);
  const output = new Float32Array(outputLength);
  const ratio = rate / CAPTURE_SAMPLE_RATE_HZ;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(lowerIndex + 1, source.length - 1);
    const fraction = position - lowerIndex;
    output[index] = source[lowerIndex] + (source[upperIndex] - source[lowerIndex]) * fraction;
  }
  return output;
}

export function createStreamingResampler(inputSampleRateHz) {
  const rate = validateSampleRate(inputSampleRateHz);
  let pending = new Float32Array(0);
  let phase = 0;

  return {
    push(samples) {
      const source = normalizeSamples(samples);
      if (source.length === 0) return new Float32Array(0);
      if (source.length > MAX_SAMPLES_PER_PUSH) throw new RangeError("capture chunk is too large");
      if (rate === CAPTURE_SAMPLE_RATE_HZ) return new Float32Array(source);

      const merged = new Float32Array(pending.length + source.length);
      merged.set(pending);
      merged.set(source, pending.length);
      const ratio = rate / CAPTURE_SAMPLE_RATE_HZ;

      const output = [];
      while (phase + 1 < merged.length) {
        const lowerIndex = Math.floor(phase);
        const upperIndex = lowerIndex + 1;
        const fraction = phase - lowerIndex;
        output.push(merged[lowerIndex] + (merged[upperIndex] - merged[lowerIndex]) * fraction);
        phase += ratio;
      }

      const consumed = Math.floor(phase);
      if (consumed < merged.length) {
        pending = merged.slice(consumed);
        phase -= consumed;
      } else {
        pending = new Float32Array(0);
        phase -= merged.length;
      }

      return Float32Array.from(output);
    },
    reset() {
      pending = new Float32Array(0);
      phase = 0;
    },
    pendingSampleCount() {
      return pending.length;
    },
  };
}

export function createFrameAccumulator({ frameSamples = CAPTURE_FRAME_SAMPLES } = {}) {
  if (!Number.isInteger(frameSamples) || frameSamples < 1 || frameSamples > 16000) {
    throw new RangeError("frameSamples is outside the allowed range");
  }

  let pending = new Float32Array(0);
  return {
    push(samples) {
      const source = normalizeSamples(samples);
      if (source.length > MAX_SAMPLES_PER_PUSH) throw new RangeError("capture chunk is too large");
      if (source.length === 0) return [];

      const merged = new Float32Array(pending.length + source.length);
      merged.set(pending);
      merged.set(source, pending.length);
      const frames = [];
      let offset = 0;
      while (offset + frameSamples <= merged.length) {
        frames.push(merged.slice(offset, offset + frameSamples));
        offset += frameSamples;
      }
      pending = merged.slice(offset);
      return frames;
    },
    reset() {
      pending = new Float32Array(0);
    },
    pendingSampleCount() {
      return pending.length;
    },
  };
}

export function encodeMonoPcm16LittleEndian(samples) {
  const source = normalizeSamples(samples);
  const encoded = new Uint8Array(source.length * 2);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < source.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, source[index]));
    const intSample = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(index * 2, intSample, true);
  }
  return encoded;
}

export function downmixToMono(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return normalizeSamples(channels[0]);

  const length = channels[0]?.length || 0;
  const mono = new Float32Array(length);
  const channelCount = channels.length;
  for (let ch = 0; ch < channelCount; ch += 1) {
    const channel = normalizeSamples(channels[ch]);
    const limit = Math.min(length, channel.length);
    for (let index = 0; index < limit; index += 1) {
      mono[index] += channel[index] / channelCount;
    }
  }
  return mono;
}

// Minimum amplitude below which we clamp to silence floor (-96 dBFS).
const MIN_RMS_AMPLITUDE = 1e-10;
// Reference amplitude for dBFS conversion (full-scale = 0 dB).
export const RMS_SILENCE_DB = -96;

/**
 * Compute root-mean-square energy of a mono float32 frame in dBFS.
 * Returns RMS_SILENCE_DB for silent / empty frames.
 */
export function computeRmsDb(samples) {
  const source = normalizeSamples(samples);
  if (source.length === 0) return RMS_SILENCE_DB;
  let sumSquares = 0;
  for (let i = 0; i < source.length; i++) {
    sumSquares += source[i] * source[i];
  }
  const rms = Math.sqrt(sumSquares / source.length);
  if (rms < MIN_RMS_AMPLITUDE) return RMS_SILENCE_DB;
  return 20 * Math.log10(rms);
}

function normalizeSamples(samples) {
  if (samples instanceof Float32Array) return samples;
  if (Array.isArray(samples)) return Float32Array.from(samples);
  return new Float32Array(0);
}

function validateSampleRate(rate) {
  if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) {
    throw new RangeError("inputSampleRateHz is outside supported bounds (8000-96000)");
  }
  return rate;
}
