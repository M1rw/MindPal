import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "../../core/layer-link";
import {
  CAPTURE_FRAME_SAMPLES,
  calculateRms,
  floatToPcm16,
  LinearDownsampler,
} from "./capture-math";
import {
  CAPTURE_CONSTRAINTS,
  CaptureManager,
  type CaptureMetrics,
} from "./capture-manager";

type FakePort = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  readonly posts: Array<{
    readonly payload: unknown;
    readonly transfers: readonly ArrayBuffer[];
  }>;
  postMessage(payload: unknown, transfers?: readonly ArrayBuffer[]): void;
  receive(payload: unknown): void;
};

class TestPort implements FakePort {
  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  public readonly posts: Array<{
    readonly payload: unknown;
    readonly transfers: readonly ArrayBuffer[];
  }> = [];

  public postMessage(
    payload: unknown,
    transfers: readonly ArrayBuffer[] = [],
  ): void {
    this.posts.push({ payload, transfers });
  }

  public receive(payload: unknown): void {
    this.onmessage?.({ data: payload } as MessageEvent<unknown>);
  }
}

class TestAudioWorkletProcessor {
  public readonly port = new TestPort();
}

class TestTrack {
  public enabled = true;
  public stopped = false;

  public stop(): void {
    this.stopped = true;
  }
}

class TestStream {
  public readonly track = new TestTrack();

  public getAudioTracks(): TestTrack[] {
    return [this.track];
  }

  public getTracks(): TestTrack[] {
    return [this.track];
  }
}

class TestSourceNode {
  public connectedTo: unknown = null;
  public disconnected = false;

  public connect(node: unknown): void {
    this.connectedTo = node;
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

class TestGainNode {
  public readonly gain = { value: 1 };
  public connectedTo: unknown = null;
  public disconnected = false;

  public connect(node: unknown): void {
    this.connectedTo = node;
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

class TestAudioContext {
  public readonly sampleRate = 48_000;
  public state: AudioContextState = "running";
  public readonly destination = {} as AudioDestinationNode;
  public readonly audioWorklet = {
    addModule: vi.fn(async (_url: string | URL) => undefined),
  };
  public readonly sourceNode = new TestSourceNode();
  public readonly sinkNode = new TestGainNode();

  public createGain(): GainNode {
    return this.sinkNode as unknown as GainNode;
  }

  public createMediaStreamSource(
    _stream: MediaStream,
  ): MediaStreamAudioSourceNode {
    return this.sourceNode as unknown as MediaStreamAudioSourceNode;
  }

  public async close(): Promise<void> {
    this.state = "closed";
  }
}

class TestAudioWorkletNode {
  public static latest: TestAudioWorkletNode | null = null;
  public readonly port = new TestPort();
  public disconnected = false;
  public connectedTo: unknown = null;

  public connect(node: unknown): void {
    this.connectedTo = node;
  }

  public constructor(
    _context: AudioContext,
    _name: string,
    _options: AudioWorkletNodeOptions,
  ) {
    TestAudioWorkletNode.latest = this;
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

function createSine(
  sampleCount: number,
  frequency = 440,
  sampleRate = 48_000,
): Float32Array {
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    output[index] =
      0.5 * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return output;
}

type ProcessorLike = TestAudioWorkletProcessor & {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
};

async function loadCaptureProcessor(): Promise<{
  readonly Processor: new (options?: AudioWorkletNodeOptions) => ProcessorLike;
}> {
  vi.resetModules();
  let registeredProcessor:
    (new (options?: AudioWorkletNodeOptions) => ProcessorLike) | null = null;
  Object.defineProperty(globalThis, "sampleRate", {
    configurable: true,
    value: 48_000,
  });
  Object.defineProperty(globalThis, "currentTime", {
    configurable: true,
    value: 2.5,
  });
  Object.defineProperty(globalThis, "AudioWorkletProcessor", {
    configurable: true,
    value: TestAudioWorkletProcessor,
  });
  Object.defineProperty(globalThis, "registerProcessor", {
    configurable: true,
    value: (
      _name: string,
      processor: new (options?: AudioWorkletNodeOptions) => ProcessorLike,
    ) => {
      registeredProcessor = processor;
    },
  });

  await import("./capture-processor");
  if (!registeredProcessor)
    throw new Error("CaptureProcessor was not registered");
  return { Processor: registeredProcessor };
}

describe("capture DSP", () => {
  it("downsamples 48 kHz input to 16 kHz and preserves a 20 ms frame size", () => {
    const downsampler = new LinearDownsampler(48_000, 16_000);
    const output = downsampler.push(createSine(960));

    expect(output).toHaveLength(CAPTURE_FRAME_SAMPLES);
    expect(output.some((sample) => Math.abs(sample) > 0.1)).toBe(true);

    const pcm = floatToPcm16(output);
    expect(pcm).toHaveLength(320);
    expect(pcm.byteLength).toBe(640);
    expect(calculateRms(output)).toBeGreaterThan(0.34);
    expect(calculateRms(output)).toBeLessThan(0.37);
  });

  it("emits downsampled PCM16 with RMS calculated after resampling and transfers the buffer", async () => {
    const { Processor } = await loadCaptureProcessor();
    const processor = new Processor();
    const port = processor.port as unknown as TestPort;
    const input = createSine(960);

    processor.process([[input]], [], {});

    expect(port.posts).toHaveLength(1);
    const message = port.posts[0]?.payload as {
      readonly type: string;
      readonly frame: AudioFrame;
    };
    const transfer = port.posts[0]?.transfers[0];
    expect(message.type).toBe("capture.frame");
    expect(message.frame.sampleRate).toBe(16_000);
    expect(message.frame.durationMs).toBe(20);
    expect(message.frame.data.byteLength).toBe(640);
    expect(message.frame.rms).toBeGreaterThan(0.34);
    expect(message.frame.rms).toBeLessThan(0.37);
    expect(transfer).toBe(message.frame.data);
    expect(
      new Int16Array(message.frame.data).some((sample) => sample !== 0),
    ).toBe(true);
  });

  it("keeps the provider stream alive with zeroed PCM16 frames while muted", async () => {
    const { Processor } = await loadCaptureProcessor();
    const processor = new Processor();
    const port = processor.port as unknown as TestPort;
    port.receive({ type: "setMuted", muted: true });

    processor.process([[createSine(960)]], [], {});

    const message = port.posts[0]?.payload as { readonly frame: AudioFrame };
    const pcm = new Int16Array(message.frame.data);
    expect(message.frame.muted).toBe(true);
    expect(message.frame.rms).toBe(0);
    expect(pcm.every((sample) => sample === 0)).toBe(true);
    expect(port.posts[0]?.transfers[0]).toBe(message.frame.data);
  });
});

describe("CaptureManager", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: TestAudioWorkletNode,
    });
  });

  it("requests the required microphone constraints and handles local mute without stopping capture", async () => {
    const stream = new TestStream();
    const getUserMedia = vi.fn(
      async (_constraints: MediaStreamConstraints) =>
        stream as unknown as MediaStream,
    );
    const mediaDevices = { getUserMedia } as unknown as MediaDevices;
    const context = new TestAudioContext();
    const metrics: CaptureMetrics[] = [];
    const manager = new CaptureManager({
      mediaDevices,
      audioContextFactory: () => context as unknown as AudioContext,
      workletModuleUrl: "capture-processor.js",
      onMetrics: (value) => metrics.push(value),
    });

    await manager.start();
    expect(getUserMedia).toHaveBeenCalledWith(CAPTURE_CONSTRAINTS);
    expect(manager.isRunning).toBe(true);
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith(
      "capture-processor.js",
    );
    expect(context.sinkNode.gain.value).toBe(0);
    expect(context.sinkNode.connectedTo).toBe(context.destination);

    manager.setMuted(true);
    expect(manager.isMuted).toBe(true);
    expect(stream.track.enabled).toBe(false);
    expect(metrics.at(-1)?.muted).toBe(true);

    manager.setMuted(false);
    expect(manager.isMuted).toBe(false);
    expect(stream.track.enabled).toBe(true);

    await manager.stop();
    expect(manager.isRunning).toBe(false);
    expect(stream.track.stopped).toBe(true);
    expect(context.state).toBe("closed");
  });

  it("rejects a suspended microphone AudioContext instead of reporting active capture", async () => {
    const context = new TestAudioContext();
    context.state = "suspended";
    const diagnostics: string[] = [];
    const manager = new CaptureManager({
      mediaDevices: {
        getUserMedia: vi.fn(
          async () => new TestStream() as unknown as MediaStream,
        ),
      } as unknown as MediaDevices,
      audioContextFactory: () => context as unknown as AudioContext,
      workletModuleUrl: "capture-processor.js",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.type),
    });

    await expect(manager.start()).rejects.toThrow("audio context is suspended");
    expect(diagnostics).toEqual(["capture-error"]);
    expect(manager.isRunning).toBe(false);
  });

  it("rejects malformed worklet frames instead of forwarding them", async () => {
    const stream = new TestStream();
    const diagnostics: string[] = [];
    const manager = new CaptureManager({
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
      } as unknown as MediaDevices,
      audioContextFactory: () =>
        new TestAudioContext() as unknown as AudioContext,
      workletModuleUrl: "capture-processor.js",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.type),
    });

    await manager.start();
    const activeWorklet = TestAudioWorkletNode.latest;
    if (!activeWorklet)
      throw new Error("fake AudioWorkletNode was not created");
    activeWorklet.port.receive({
      type: "capture.frame",
      frame: { sampleRate: 48_000, data: new ArrayBuffer(10) },
    });
    expect(diagnostics).toEqual(["capture-started", "capture-frame-rejected"]);
    await manager.stop();
  });
});
