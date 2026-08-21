import type { AudioFrame } from "../../core/layer-link";

export const HIGH_WATERMARK = 12 as const;
export const LOW_WATERMARK = 4 as const;
export const HARD_LIMIT = 50 as const;

export type FrameQueueSignal =
  | { readonly type: "transport.backpressure.high"; readonly depth: number }
  | { readonly type: "transport.backpressure.low"; readonly depth: number }
  | {
      readonly type: "transport.frame.dropped";
      readonly frame: AudioFrame;
      readonly depth: number;
      readonly reason: "hard-limit";
    };

export type FrameQueueOptions = {
  readonly highWatermark?: number;
  readonly lowWatermark?: number;
  readonly hardLimit?: number;
  readonly onSignal?: (signal: FrameQueueSignal) => void;
};

/**
 * Bounded FIFO for capture frames. It owns no transport state and never grows
 * beyond hardLimit. Oldest frames are evicted under pressure so the realtime
 * stream favors recent microphone audio over stale backlog.
 */
export class AudioFrameQueue {
  private readonly frames: AudioFrame[] = [];
  private readonly highWatermarkLimit: number;
  private readonly lowWatermarkLimit: number;
  private readonly hardLimit: number;
  private readonly onSignal: ((signal: FrameQueueSignal) => void) | undefined;
  private highWatermarkActive = false;

  public constructor(options: FrameQueueOptions = {}) {
    this.highWatermarkLimit = options.highWatermark ?? HIGH_WATERMARK;
    this.lowWatermarkLimit = options.lowWatermark ?? LOW_WATERMARK;
    this.hardLimit = options.hardLimit ?? HARD_LIMIT;
    this.onSignal = options.onSignal;
    if (
      this.lowWatermarkLimit < 0 ||
      this.highWatermarkLimit <= this.lowWatermarkLimit ||
      this.hardLimit <= this.highWatermarkLimit
    ) {
      throw new RangeError("watermarks must satisfy 0 <= low < high < hardLimit");
    }
  }

  public enqueue(frame: AudioFrame): void {
    if (this.frames.length >= this.hardLimit) {
      const dropped = this.frames.shift();
      if (dropped) {
        this.emit({
          type: "transport.frame.dropped",
          frame: dropped,
          depth: this.frames.length,
          reason: "hard-limit",
        });
      }
    }

    this.frames.push(frame);
    if (!this.highWatermarkActive && this.frames.length > this.highWatermarkLimit) {
      this.highWatermarkActive = true;
      this.emit({
        type: "transport.backpressure.high",
        depth: this.frames.length,
      });
    }
  }

  public dequeue(): AudioFrame | undefined {
    const frame = this.frames.shift();
    if (this.highWatermarkActive && this.frames.length <= this.lowWatermarkLimit) {
      this.highWatermarkActive = false;
      this.emit({
        type: "transport.backpressure.low",
        depth: this.frames.length,
      });
    }
    return frame;
  }

  public peek(): AudioFrame | undefined {
    return this.frames[0];
  }

  public clear(): AudioFrame[] {
    const cleared = this.frames.splice(0);
    this.highWatermarkActive = false;
    return cleared;
  }

  public get size(): number {
    return this.frames.length;
  }

  public get capacity(): number {
    return this.hardLimit;
  }

  public get highWatermark(): number {
    return this.highWatermarkLimit;
  }

  public get lowWatermark(): number {
    return this.lowWatermarkLimit;
  }

  private emit(signal: FrameQueueSignal): void {
    try {
      this.onSignal?.(signal);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.debug("[Transport] queue signal handler failed", error);
      }
    }
  }
}
