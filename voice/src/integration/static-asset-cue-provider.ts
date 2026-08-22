import type { AudioChunk, GenerationIdentity } from "../core/layer-link";
import { SyntheticCueProvider, type CueProvider } from "../layers/backchannel/cue-provider";

export type StaticCueName = "mhm" | "yeah" | "aha";

export type StaticAssetCueProviderOptions = {
  readonly audioContextFactory: () => AudioContext | Promise<AudioContext>;
  readonly fetchImpl?: typeof fetch;
  readonly assetBasePath?: string;
  readonly cueNames?: readonly StaticCueName[];
  readonly fallbackProvider?: CueProvider;
};

/** Loads localized prerecorded cues once and returns cached buffers synchronously after preload. */
export class StaticAssetCueProvider implements CueProvider {
  private readonly audioContextFactory: () => AudioContext | Promise<AudioContext>;
  private readonly fetchImpl: typeof fetch;
  private readonly assetBasePath: string;
  private readonly cueNames: readonly StaticCueName[];
  private readonly fallbackProvider: CueProvider;
  private readonly decodedBuffers = new Map<StaticCueName, AudioBuffer>();
  private readonly pcm16Buffers = new Map<StaticCueName, ArrayBuffer>();
  private preloadPromise: Promise<void> | null = null;
  private fallbackActive = false;
  private cueIndex = 0;

  public constructor(options: StaticAssetCueProviderOptions) {
    this.audioContextFactory = options.audioContextFactory;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.assetBasePath = (options.assetBasePath ?? "/assets/cues").replace(/\/$/, "");
    this.cueNames = options.cueNames?.length ? options.cueNames : ["mhm", "yeah", "aha"];
    this.fallbackProvider = options.fallbackProvider ?? new SyntheticCueProvider();
  }

  /** Sprint 9 lifecycle name; aliases preload for compatibility with the app root. */
  public initialize(): Promise<void> {
    return this.preload();
  }

  public preload(): Promise<void> {
    if (!this.preloadPromise) {
      this.preloadPromise = this.loadAssets().catch(() => {
        this.fallbackActive = true;
        this.decodedBuffers.clear();
        this.pcm16Buffers.clear();
      });
    }
    return this.preloadPromise;
  }

  public hasLoadedAssets(): boolean {
    return !this.fallbackActive && this.pcm16Buffers.size === this.cueNames.length;
  }

  public createCue(identity: GenerationIdentity, cueId: string): AudioChunk {
    if (this.fallbackActive) return this.fallbackProvider.createCue(identity, cueId);
    const name = this.cueNames[this.cueIndex % this.cueNames.length];
    this.cueIndex += 1;
    const pcm16 = name ? this.pcm16Buffers.get(name) : undefined;
    const decodedAudioBuffer = name ? this.decodedBuffers.get(name) : undefined;
    if (!pcm16 || !decodedAudioBuffer) throw new Error("Static backchannel cues are not initialized");
    return {
      chunkId: cueId,
      sequence: 0,
      format: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      data: pcm16.slice(0),
      decodedAudioBuffer,
      audioLane: "backchannel",
      identity,
    };
  }

  private async loadAssets(): Promise<void> {
    const context = await this.audioContextFactory();
    for (const cueName of this.cueNames) {
      const response = await this.fetchImpl(`${this.assetBasePath}/${cueName}.wav`, {
        method: "GET",
        cache: "force-cache",
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`Backchannel asset ${cueName} failed with HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes.slice(0));
      if (buffer.numberOfChannels !== 1 || buffer.sampleRate !== 24_000) {
        throw new Error(`Backchannel asset ${cueName} must be mono 24 kHz`);
      }
      this.decodedBuffers.set(cueName, buffer);
      this.pcm16Buffers.set(cueName, float32ToPcm16(buffer.getChannelData(0)));
    }
  }
}

function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm16 = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    pcm16[index] = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
  }
  return pcm16.buffer;
}
