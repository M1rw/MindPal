import type { AudioChunk, GenerationIdentity } from "../../core/layer-link";

export interface CueProvider {
  createCue(identity: GenerationIdentity, cueId: string): AudioChunk;
}

/**
 * Temporary local cue source for V3 development. It deliberately produces a
 * deterministic, low-amplitude 440 Hz sine tone in the backchannel lane until
 * production vocal assets or a native provider cue path are available.
 */
export class SyntheticCueProvider implements CueProvider {
  public createCue(identity: GenerationIdentity, cueId: string): AudioChunk {
    const sampleRate = 24_000;
    const durationMs = 300;
    const sampleCount = (sampleRate * durationMs) / 1_000;
    const samples = new Int16Array(sampleCount);
    const amplitude = 0.18 * 32767;
    for (let index = 0; index < samples.length; index += 1) {
      const envelope = Math.min(1, index / 240, (samples.length - index) / 240);
      samples[index] = Math.round(
        Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude * envelope,
      );
    }

    return {
      chunkId: cueId,
      sequence: 0,
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      data: samples.buffer,
      audioLane: "backchannel",
      identity,
    };
  }
}
