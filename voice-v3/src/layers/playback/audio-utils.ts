import { base64ToBytes } from "../transport/base64-utils";

export const PLAYBACK_SAMPLE_RATE = 24_000 as const;

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new RangeError("PCM16 byte payload must contain complete 16-bit samples");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = view.getInt16(index * 2, true);
    samples[index] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return samples;
}

export function base64Pcm16ToFloat32(value: string): Float32Array {
  return pcm16BytesToFloat32(base64ToBytes(value));
}

export function createPcm16AudioBuffer(
  context: AudioContext,
  value: string,
  sampleRate = PLAYBACK_SAMPLE_RATE,
): AudioBuffer {
  if (sampleRate !== PLAYBACK_SAMPLE_RATE) {
    throw new RangeError(`Playback PCM must be ${PLAYBACK_SAMPLE_RATE} Hz`);
  }
  const samples = base64Pcm16ToFloat32(value);
  const buffer = context.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
  buffer.copyToChannel(samples as unknown as Float32Array<ArrayBuffer>, 0, 0);
  return buffer;
}
