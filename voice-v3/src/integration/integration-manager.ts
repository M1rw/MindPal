import { createVoiceV3App, type VoiceProviderMode, type VoiceV3App, type VoiceV3AppOptions } from "../app";
import type { CueProvider } from "../layers/backchannel/cue-provider";
import type { TokenProvider } from "../layers/transport/token-provider";
import { MockTokenProvider } from "../layers/transport/token-provider";
import { SyntheticCueProvider } from "../layers/backchannel/cue-provider";
import { RealTokenProvider, type RealTokenProviderOptions } from "./real-token-provider";
import type { RealtimeTTSProviderOptions } from "../layers/backchannel/realtime-tts-provider";

export type IntegrationManagerOptions = {
  readonly mode?: VoiceProviderMode;
  readonly realToken?: RealTokenProviderOptions;
  /** @deprecated Retained for compatibility; Gemini Native Audio is the default cue source. */
  readonly realtimeTts?: RealtimeTTSProviderOptions;
  /** Optional explicit legacy cue provider for isolated tests only. */
  readonly cueProvider?: CueProvider;
  readonly appOptions?: Omit<VoiceV3AppOptions, "providerMode" | "tokenProvider" | "cueProvider">;
};

/** Selects production integrations without coupling the UI to transport internals. */
export class IntegrationManager {
  private readonly mode: VoiceProviderMode;
  private readonly realTokenOptions: RealTokenProviderOptions;
  private readonly realtimeTtsOptions: RealtimeTTSProviderOptions;
  private readonly cueProvider: CueProvider | undefined;
  private readonly appOptions: Omit<VoiceV3AppOptions, "providerMode" | "tokenProvider" | "cueProvider">;
  private realTokenProvider: RealTokenProvider | null = null;

  public constructor(options: IntegrationManagerOptions = {}) {
    this.mode = options.mode ?? "mock";
    this.realTokenOptions = options.realToken ?? {};
    this.realtimeTtsOptions = options.realtimeTts ?? {};
    this.cueProvider = options.cueProvider;
    this.appOptions = options.appOptions ?? {};
  }

  public createTokenProvider(): TokenProvider {
    if (this.mode === "mock") return new MockTokenProvider();
    this.realTokenProvider = new RealTokenProvider(this.realTokenOptions);
    return this.realTokenProvider;
  }

  public createCueProvider(_audioContextFactory: () => AudioContext | Promise<AudioContext>): CueProvider {
    // Gemini Native Audio is the default for both modes. A caller may inject a
    // legacy provider explicitly, but real mode never contacts external TTS here.
    return this.cueProvider ?? new SyntheticCueProvider();
  }

  public async createApp(): Promise<VoiceV3App> {
    const tokenProvider = this.createTokenProvider();
    let app: VoiceV3App;
    app = createVoiceV3App({
      ...this.appOptions,
      providerMode: this.mode,
      tokenProvider,
      ...(this.cueProvider === undefined ? {} : { cueProvider: this.cueProvider }),
    });
    return app;
  }

  public get realProvider(): RealTokenProvider | null {
    return this.realTokenProvider;
  }
}
