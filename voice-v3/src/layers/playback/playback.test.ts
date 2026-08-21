import { describe, expect, it, vi } from "vitest";
import type { AudioChunk, GenerationIdentity } from "../../core/layer-link";
import { bytesToBase64 } from "../transport/base64-utils";
import {
  base64Pcm16ToFloat32,
  createPcm16AudioBuffer,
  PLAYBACK_SAMPLE_RATE,
} from "./audio-utils";
import { PlaybackManager } from "./playback-manager";

type RampCall = { readonly value: number; readonly time: number };

class FakeAudioParam {
  public value = 1;
  public readonly ramps: RampCall[] = [];
  public readonly setCalls: RampCall[] = [];
  public readonly cancelCalls: number[] = [];

  public cancelScheduledValues(time: number): void {
    this.cancelCalls.push(time);
  }

  public setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.setCalls.push({ value, time });
  }

  public linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.ramps.push({ value, time });
  }
}

class FakeBuffer {
  public readonly duration: number;
  public readonly copied: Float32Array[] = [];

  public constructor(
    public readonly numberOfChannels: number,
    public readonly length: number,
    public readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
  }

  public copyToChannel(data: Float32Array, _channelNumber: number, _startInChannel?: number): void {
    this.copied.push(data);
  }
}

class FakeSource {
  public buffer: AudioBuffer | null = null;
  public onended: (() => void) | null = null;
  public startTimes: number[] = [];
  public stopCalls = 0;
  public connectedTo: unknown = null;

  public connect(destination: unknown): void {
    this.connectedTo = destination;
  }

  public start(when = 0): void {
    this.startTimes.push(when);
  }

  public stop(): void {
    this.stopCalls += 1;
  }
}

class FakeContext {
  public currentTime = 10;
  public state: AudioContextState = "suspended";
  public readonly destination = {};
  public readonly mainGain = { gain: new FakeAudioParam(), connect: vi.fn() };
  public readonly backchannelGain = { gain: new FakeAudioParam(), connect: vi.fn() };
  public readonly compressor = { connect: vi.fn() };
  public readonly analyser = { connect: vi.fn() };
  public readonly sources: FakeSource[] = [];
  public resumeCalls = 0;
  public readonly buffers: FakeBuffer[] = [];
  private gainCount = 0;

  public async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }

  public createGain(): GainNode {
    this.gainCount += 1;
    return (this.gainCount === 1 ? this.mainGain : this.backchannelGain) as unknown as GainNode;
  }

  public createDynamicsCompressor(): DynamicsCompressorNode {
    return this.compressor as unknown as DynamicsCompressorNode;
  }

  public createAnalyser(): AnalyserNode {
    return this.analyser as unknown as AnalyserNode;
  }

  public createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const buffer = new FakeBuffer(1, length, sampleRate);
    this.buffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

function identity(generationId: string): GenerationIdentity {
  return {
    sessionGeneration: "session-1",
    turnId: "turn-1",
    providerResponseId: "response-1",
    playbackGeneration: generationId,
  };
}

function audioChunk(generationId: string, sequence: number, audioLane: "main" | "backchannel" = "main"): AudioChunk {
  return {
    chunkId: `chunk-${sequence}`,
    sequence,
    format: "pcm_s16le",
    sampleRate: PLAYBACK_SAMPLE_RATE,
    channels: 1,
    data: new Int16Array(2_400).buffer,
    audioLane,
    identity: identity(generationId),
  };
}

describe("playback audio utilities", () => {
  it("decodes little-endian PCM16 Base64 to normalized Float32 and creates a 24 kHz buffer", () => {
    const bytes = Uint8Array.from([0, 0, 255, 127, 0, 128]);
    const encoded = bytesToBase64(bytes);
    const samples = base64Pcm16ToFloat32(encoded);
    expect(Array.from(samples)).toEqual([0, 1, -1]);

    const context = new FakeContext();
    const buffer = createPcm16AudioBuffer(context as unknown as AudioContext, encoded);
    expect(buffer.sampleRate).toBe(24_000);
    expect(buffer.duration).toBe(3 / 24_000);
    expect(context.buffers[0]?.copied[0]).toHaveLength(3);
  });
});

describe("PlaybackManager", () => {
  it("resumes the AudioContext and schedules consecutive chunks on the continuous Web Audio clock", async () => {
    const context = new FakeContext();
    const events: string[] = [];
    const manager = new PlaybackManager({
      audioContextFactory: () => context as unknown as AudioContext,
      onEvent: (event) => events.push(event.type),
    });
    manager.activateGeneration("generation-1");

    await manager.enqueueChunk(audioChunk("generation-1", 1));
    await manager.enqueueChunk(audioChunk("generation-1", 2));

    expect(context.resumeCalls).toBe(1);
    expect(context.sources[0]?.startTimes[0]).toBeCloseTo(10.12, 6);
    expect(context.sources[1]?.startTimes[0]).toBeCloseTo(10.22, 6);
    expect(manager.snapshot.queueDepthMs).toBeCloseTo(320, 6);
    expect(events).toContain("playback.scheduled");
  });

  it("emits underrun when the scheduled clock has less than 40 ms of audio remaining", async () => {
    const context = new FakeContext();
    const events: string[] = [];
    const manager = new PlaybackManager({
      audioContextFactory: () => context as unknown as AudioContext,
      onEvent: (event) => events.push(event.type),
    });
    manager.activateGeneration("generation-1");
    await manager.enqueueChunk(audioChunk("generation-1", 1));
    context.currentTime = 10.2;
    await manager.enqueueChunk(audioChunk("generation-1", 2));
    expect(events).toContain("playback.underrun");
  });

  it("routes main at full gain and backchannel at reduced gain", async () => {
    const context = new FakeContext();
    const manager = new PlaybackManager({ audioContextFactory: () => context as unknown as AudioContext });
    manager.activateGeneration("generation-1");
    await manager.enqueueChunk(audioChunk("generation-1", 1, "main"));
    await manager.enqueueChunk(audioChunk("generation-1", 2, "backchannel"));

    expect(manager.snapshot.mainGain).toBe(1);
    expect(manager.snapshot.backchannelGain).toBe(0.4);
    expect(context.mainGain.connect).toHaveBeenCalledWith(context.compressor);
    expect(context.backchannelGain.connect).toHaveBeenCalledWith(context.compressor);
    expect(context.compressor.connect).toHaveBeenCalledWith(context.analyser);
    expect(context.analyser.connect).toHaveBeenCalledWith(context.destination);
    expect(context.sources[0]?.connectedTo).toBe(context.mainGain);
    expect(context.sources[1]?.connectedTo).toBe(context.backchannelGain);
  });

  it("ramps main gain to 0.32 in 20 ms and restores to 1.0 in 150 ms", () => {
    const context = new FakeContext();
    const manager = new PlaybackManager({ audioContextFactory: () => context as unknown as AudioContext });
    manager.duckMainLane();
    manager.restoreMainLane();

    expect(context.mainGain.gain.ramps).toEqual([
      { value: 0.32, time: 10.02 },
      { value: 1, time: 10.15 },
    ]);
  });

  it("adapts backchannel gain for quiet/sad prosody and fades faster for urgent main speech", async () => {
    const context = new FakeContext();
    const manager = new PlaybackManager({ audioContextFactory: () => context as unknown as AudioContext });
    manager.setProsodyState({ energyLevel: "low", speechRate: "slow", pausePattern: "hesitant", emotionalGuess: "sad", confidence: 0.8, lastChangedAtMono: 0 });
    expect(manager.snapshot.backchannelGain).toBeCloseTo(0.3, 6);

    manager.setProsodyState({ energyLevel: "high", speechRate: "very_fast", pausePattern: "abrupt", emotionalGuess: "urgent", confidence: 0.8, lastChangedAtMono: 0 });
    manager.activateGeneration("generation-1");
    await manager.enqueueChunk(audioChunk("generation-1", 1, "backchannel"));
    await manager.enqueueChunk(audioChunk("generation-1", 2, "main"));

    expect(context.backchannelGain.gain.ramps.some((ramp) => ramp.value === 0)).toBe(true);
    expect(context.backchannelGain.gain.ramps.some((ramp) => ramp.value === 0.4)).toBe(true);
  });

  it("rejects stale generations and flushes all scheduled sources for a generation", async () => {
    const context = new FakeContext();
    const events: string[] = [];
    const manager = new PlaybackManager({
      audioContextFactory: () => context as unknown as AudioContext,
      onEvent: (event) => events.push(event.type),
    });
    manager.activateGeneration("generation-old");
    await manager.enqueueChunk(audioChunk("generation-old", 1));
    manager.activateGeneration("generation-new");
    const staleAccepted = await manager.enqueueChunk(audioChunk("generation-old", 2));
    expect(staleAccepted).toBe(false);
    expect(events).toContain("playback.stale_chunk.rejected");
    expect(context.sources[0]?.stopCalls).toBe(1);

    await manager.enqueueChunk(audioChunk("generation-new", 3));
    manager.flush("generation-new");
    expect(context.sources[1]?.stopCalls).toBe(1);
    expect(manager.queueDepthMs).toBe(0);
    expect(events).toContain("playback.flushed");
  });
});
