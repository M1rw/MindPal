import {
  calculateRms,
  CAPTURE_FRAME_SAMPLES,
  createSilencePcm16,
  floatToPcm16,
  LinearDownsampler,
  TARGET_CAPTURE_SAMPLE_RATE,
} from "./capture-math";
import type { AudioFrame } from "../../core/layer-link";

/**
 * AudioWorklet has no DOM, React, window, or application state. These minimal
 * declarations describe the standard worklet globals for strict TypeScript;
 * the actual implementations are supplied by the browser audio thread.
 */
declare abstract class AudioWorkletProcessor {
  public readonly port: MessagePort;
  public constructor(options?: AudioWorkletNodeOptions);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentTime: number;

type CaptureProcessorMessage =
  | { readonly type: "setMuted"; readonly muted: boolean }
  | { readonly type: "reset" };

type CaptureFrameMessage = {
  readonly type: "capture.frame";
  readonly frame: AudioFrame;
};

/**
 * Runs strictly inside the browser AudioWorklet thread.
 * Do not access the DOM, React, fetch, timers, or main-thread application state.
 */
export class CaptureProcessor extends AudioWorkletProcessor {
  private readonly downsampler: LinearDownsampler;
  private readonly frameSamples: number[] = [];
  private muted = false;
  private sequence = 0;
  private frameCounter = 0;

  public constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const nativeRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
    this.downsampler = new LinearDownsampler(nativeRate, TARGET_CAPTURE_SAMPLE_RATE);
    this.port.onmessage = (event: MessageEvent<CaptureProcessorMessage>) => {
      const message = event.data;
      if (message?.type === "setMuted") {
        this.muted = Boolean(message.muted);
      } else if (message?.type === "reset") {
        this.resetState();
      }
    };
  }

  public process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const monoInput = this.toMono(inputs[0] ?? []);
    const resampled = this.downsampler.push(monoInput);

    if (resampled.length > 0) {
      if (this.muted) {
        this.appendSilence(resampled.length);
      } else {
        for (let index = 0; index < resampled.length; index += 1) {
          this.frameSamples.push(resampled[index] ?? 0);
        }
      }
    }

    this.emitCompleteFrames();
    return true;
  }

  private toMono(channels: Float32Array[]): Float32Array {
    if (channels.length === 0) return new Float32Array(0);
    if (channels.length === 1) return channels[0] ?? new Float32Array(0);

    const length = channels.reduce((maximum, channel) => Math.max(maximum, channel.length), 0);
    const mono = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      let total = 0;
      let present = 0;
      for (const channel of channels) {
        if (index < channel.length) {
          total += channel[index] ?? 0;
          present += 1;
        }
      }
      mono[index] = present > 0 ? total / present : 0;
    }
    return mono;
  }

  private appendSilence(length: number): void {
    for (let index = 0; index < length; index += 1) this.frameSamples.push(0);
  }

  private emitCompleteFrames(): void {
    while (this.frameSamples.length >= CAPTURE_FRAME_SAMPLES) {
      const frameFloat = Float32Array.from(
        this.frameSamples.splice(0, CAPTURE_FRAME_SAMPLES),
      );
      const pcm = this.muted ? createSilencePcm16(CAPTURE_FRAME_SAMPLES) : floatToPcm16(frameFloat);
      const frame: AudioFrame = {
        frameId: `capture-frame-${this.frameCounter++}`,
        sequence: this.sequence++,
        sampleRate: TARGET_CAPTURE_SAMPLE_RATE,
        channels: 1,
        format: "pcm_s16le",
        data: pcm.buffer as ArrayBuffer,
        capturedAtMono: currentTime * 1000,
        durationMs: 20,
        muted: this.muted,
        rms: this.muted ? 0 : calculateRms(frameFloat),
      };
      const payload: CaptureFrameMessage = { type: "capture.frame", frame };
      // The PCM buffer is transferred, not copied, across the worklet boundary.
      this.port.postMessage(payload, [pcm.buffer as ArrayBuffer]);
    }
  }

  private resetState(): void {
    this.downsampler.reset();
    this.frameSamples.length = 0;
    this.sequence = 0;
    this.frameCounter = 0;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("mindpal-voice-v3-capture", CaptureProcessor);
}
