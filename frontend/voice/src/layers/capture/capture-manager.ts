import type { AudioFrame } from "../../core/layer-link";
import captureProcessorUrl from "./capture-processor.ts?worker&url";

export const CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

export type CaptureMetrics = {
  readonly rms: number;
  readonly muted: boolean;
  readonly sampleRate: number;
  readonly framesEmitted: number;
  readonly lastSequence: number | null;
};

export type CaptureDiagnostic = {
  readonly type:
    | "capture-started"
    | "capture-stopped"
    | "capture-muted"
    | "capture-unmuted"
    | "capture-frame-rejected"
    | "capture-error";
  readonly reason?: string;
  readonly error?: unknown;
};

export type CaptureManagerOptions = {
  readonly mediaDevices?: MediaDevices;
  readonly audioContextFactory?: () => AudioContext;
  readonly workletModuleUrl?: string | URL;
  readonly nowMono?: () => number;
  readonly onFrame?: (frame: AudioFrame) => void;
  readonly onMetrics?: (metrics: CaptureMetrics) => void;
  readonly onDiagnostic?: (diagnostic: CaptureDiagnostic) => void;
};

type CaptureFrameMessage = {
  readonly type: "capture.frame";
  readonly frame: AudioFrame;
};

/**
 * Main-thread controller for the isolated CaptureProcessor.
 * It owns permissions, MediaStream tracks, AudioContext lifecycle, and the
 * application callback. PCM DSP itself never runs here; it runs in the worklet.
 */
export class CaptureManager {
  private readonly mediaDevices: MediaDevices;
  private readonly audioContextFactory: () => AudioContext;
  private readonly workletModuleUrl: string | URL;
  private readonly onFrame: ((frame: AudioFrame) => void) | undefined;
  private readonly onMetrics: ((metrics: CaptureMetrics) => void) | undefined;
  private readonly onDiagnostic:
    ((diagnostic: CaptureDiagnostic) => void) | undefined;
  private readonly nowMono: () => number;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private captureSinkNode: GainNode | null = null;
  private muted = false;
  private framesEmitted = 0;
  private lastSequence: number | null = null;
  private lastRms = 0;
  private running = false;

  public constructor(options: CaptureManagerOptions = {}) {
    this.mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    this.audioContextFactory =
      options.audioContextFactory ?? (() => new AudioContext());
    this.workletModuleUrl = options.workletModuleUrl ?? captureProcessorUrl;
    this.onFrame = options.onFrame;
    this.onMetrics = options.onMetrics;
    this.onDiagnostic = options.onDiagnostic;
    this.nowMono = options.nowMono ?? (() => performance.now());
  }

  public async start(): Promise<void> {
    if (this.running) return;
    if (!this.mediaDevices?.getUserMedia) {
      const error = new Error("MediaDevices.getUserMedia is unavailable");
      this.report({ type: "capture-error", reason: error.message, error });
      throw error;
    }

    try {
      this.mediaStream =
        await this.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS);
      this.audioContext = this.audioContextFactory();
      if (typeof this.audioContext.resume === "function")
        await this.audioContext.resume();
      if (this.audioContext.state === "suspended") {
        throw new Error(
          "Microphone audio context is suspended; capture cannot start",
        );
      }
      await this.audioContext.audioWorklet.addModule(this.workletModuleUrl);

      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "mindpal-voice-v3-capture",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      this.workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        this.handleWorkletMessage(event.data);
      };
      this.workletNode.port.onmessageerror = (event: MessageEvent<unknown>) => {
        this.report({
          type: "capture-error",
          reason: "AudioWorklet message could not be deserialized",
          error: event,
        });
      };

      this.sourceNode = this.audioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.workletNode);
      // An AudioWorkletNode that is left entirely disconnected may not be
      // pulled by the browser’s render graph. Keep it alive through a silent
      // gain sink so capture frames continue without microphone feedback.
      const createGain = this.audioContext.createGain;
      if (typeof createGain === "function" && this.audioContext.destination) {
        this.captureSinkNode = createGain.call(this.audioContext);
        this.captureSinkNode.gain.value = 0;
        this.workletNode.connect(this.captureSinkNode);
        this.captureSinkNode.connect(this.audioContext.destination);
      }
      this.running = true;
      this.report({ type: "capture-started" });
      this.emitMetrics();
      this.debug("[Capture] manager started", {
        nativeSampleRate: this.audioContext.sampleRate,
        targetSampleRate: 16_000,
      });
    } catch (error) {
      this.report({
        type: "capture-error",
        reason: "capture start failed",
        error,
      });
      await this.cleanup();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.running && !this.mediaStream && !this.audioContext) return;
    await this.cleanup();
    this.report({ type: "capture-stopped" });
    this.debug("[Capture] manager stopped");
  }

  public setMuted(muted: boolean): void {
    this.muted = Boolean(muted);
    for (const track of this.mediaStream?.getAudioTracks() ?? []) {
      track.enabled = !this.muted;
    }
    this.workletNode?.port.postMessage({ type: "setMuted", muted: this.muted });
    this.report({ type: this.muted ? "capture-muted" : "capture-unmuted" });
    this.emitMetrics();
    this.debug(`[Capture] ${this.muted ? "muted" : "unmuted"}`);
  }

  public getMetrics(): CaptureMetrics {
    return {
      rms: this.lastRms,
      muted: this.muted,
      sampleRate: this.audioContext?.sampleRate ?? 0,
      framesEmitted: this.framesEmitted,
      lastSequence: this.lastSequence,
    };
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get isMuted(): boolean {
    return this.muted;
  }

  private handleWorkletMessage(message: unknown): void {
    if (!isCaptureFrameMessage(message)) {
      this.report({
        type: "capture-frame-rejected",
        reason: "unknown AudioWorklet message",
      });
      return;
    }

    const frame = message.frame;
    if (
      frame.sampleRate !== 16_000 ||
      frame.channels !== 1 ||
      frame.format !== "pcm_s16le" ||
      frame.durationMs !== 20 ||
      !(frame.data instanceof ArrayBuffer)
    ) {
      this.report({
        type: "capture-frame-rejected",
        reason: "frame does not satisfy the 16 kHz PCM16 contract",
      });
      return;
    }

    this.framesEmitted += 1;
    this.lastSequence = frame.sequence;
    this.lastRms = frame.rms;
    this.onFrame?.(frame);
    this.emitMetrics();
  }

  private emitMetrics(): void {
    this.onMetrics?.(this.getMetrics());
  }

  private report(diagnostic: CaptureDiagnostic): void {
    this.onDiagnostic?.(diagnostic);
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    this.workletNode?.port.postMessage({ type: "reset" });
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.captureSinkNode?.disconnect();
    for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.sourceNode = null;
    this.workletNode = null;
    this.captureSinkNode = null;
    this.mediaStream = null;
    this.audioContext = null;
  }

  private debug(message: string, details?: unknown): void {
    if (import.meta.env.DEV) console.debug(message, details ?? "");
  }
}

function isCaptureFrameMessage(value: unknown): value is CaptureFrameMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly type?: unknown;
    readonly frame?: unknown;
  };
  return candidate.type === "capture.frame" && isAudioFrame(candidate.frame);
}

function isAudioFrame(value: unknown): value is AudioFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<AudioFrame>;
  return (
    typeof frame.frameId === "string" &&
    typeof frame.sequence === "number" &&
    frame.sampleRate === 16_000 &&
    frame.channels === 1 &&
    frame.format === "pcm_s16le" &&
    frame.data instanceof ArrayBuffer &&
    typeof frame.capturedAtMono === "number" &&
    frame.durationMs === 20 &&
    typeof frame.muted === "boolean" &&
    typeof frame.rms === "number"
  );
}
