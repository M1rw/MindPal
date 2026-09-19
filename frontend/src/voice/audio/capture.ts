import { CAPTURE_CUTOFF_HZ, CAPTURE_TAPS } from './resample.ts';

/**
 * Capture worklet. The decimation maths is a mirror of `resample.ts` — the
 * worklet source is a string compiled in its own realm, so it cannot import.
 * `resample.ts` is the testable copy; a contract test pins the two together by
 * feeding both the same signal and comparing output sample-for-sample.
 */
const WORKLET_SOURCE = `
const TAPS = ${CAPTURE_TAPS};
const CUTOFF_HZ = ${CAPTURE_CUTOFF_HZ};
const TARGET_RATE = 16000;

function designLowpass(taps, cutoffRatio) {
  const n = Math.max(2, Math.floor(taps));
  const fc = Math.min(0.49, Math.max(1e-4, cutoffRatio));
  const kernel = new Float32Array(n);
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const t = (2 * Math.PI * i) / (n - 1);
    const window = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  if (sum !== 0) for (let i = 0; i < n; i++) kernel[i] /= sum;
  return kernel;
}

class MindPalPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = Math.max(1, sampleRate / TARGET_RATE);
    const cutoff = Math.min(CUTOFF_HZ, TARGET_RATE * 0.475);
    this._kernel = designLowpass(TAPS, cutoff / sampleRate);
    this._history = new Float32Array(this._kernel.length);
    this._phase = 0;
    this._pending = [];
    this._frame = 320;
  }

  // Polyphase decimate: the lowpass is evaluated only at output positions, so
  // the cost is TAPS multiply-adds per output sample, not per input sample.
  _decimate(input) {
    const taps = this._kernel.length;
    const history = this._history;
    const total = history.length + input.length;
    const buffer = new Float32Array(total);
    buffer.set(history, 0);
    buffer.set(input, history.length);
    let phase = this._phase;
    const out = [];
    while (phase + taps - 1 < total) {
      const base = Math.floor(phase);
      const frac = phase - base;
      let acc = 0;
      if (frac === 0) {
        for (let k = 0; k < taps; k++) acc += this._kernel[k] * buffer[base + k];
      } else {
        for (let k = 0; k < taps; k++) {
          const a = buffer[base + k];
          const b = base + k + 1 < total ? buffer[base + k + 1] : a;
          acc += this._kernel[k] * (a + (b - a) * frac);
        }
      }
      out.push(acc);
      phase += this._ratio;
    }
    const consumed = Math.max(0, Math.floor(phase) - (taps - 1));
    const keepFrom = Math.min(total, consumed);
    const tail = buffer.subarray(keepFrom);
    this._history = new Float32Array(tail.length);
    this._history.set(tail);
    this._phase = phase - keepFrom;
    return out;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const decimated = this._decimate(channel);
    for (let i = 0; i < decimated.length; i++) this._pending.push(decimated[i]);
    while (this._pending.length >= this._frame) {
      const frame = this._pending.splice(0, this._frame);
      const pcm = new Int16Array(frame.length);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const sample = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        sum += sample * sample;
      }
      this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / frame.length) }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('mindpal-pcm-capture', MindPalPcmCaptureProcessor);
`;

export interface CaptureHandle {
  context: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  stop: () => Promise<void>;
}

export interface CaptureOptions {
  /** Playback and capture must share a graph so browser AEC can hear model audio. */
  context?: AudioContext;
  onDeviceLost?: (reason: string) => void;
}

/**
 * Browser AGC is deliberately OFF.
 *
 * Two automatic gain stages in series is one too many: `EnergyNormalizer` already
 * tracks a rolling p95 reference, and the browser's AGC flattens exactly the
 * dynamics `ProsodyTracker` measures to find transition-relevance places. Echo
 * cancellation and noise suppression stay on — those the browser does better than
 * we can, and AEC is load-bearing for barge-in while model audio is playing.
 */
export const CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  channelCount: 1,
};

/**
 * The capture worklet could not be installed, so there is no audio path at all.
 *
 * Distinct from a microphone failure: the device may be perfectly available and
 * already granted. Carries the original cause so the session can say which.
 */
export class CaptureWorkletError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`capture worklet unavailable (${detail})`);
    this.name = 'CaptureWorkletError';
    this.cause = cause;
  }
}

export async function startPcmCapture(
  onFrame: (pcm: Int16Array, rms: number) => void,
  options?: CaptureOptions,
): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: CAPTURE_CONSTRAINTS,
    video: false,
  });

  const ownsContext = !options?.context || options.context.state === 'closed';
  const context = !ownsContext && options?.context ? options.context : new AudioContext({ latencyHint: 'interactive' });
  const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  let addModuleError: unknown = null;
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    // Re-registering on a shared context is fine and expected. Anything else is
    // the worklet genuinely not loading, and swallowing it only moved the crash
    // one line down: `new AudioWorkletNode` then threw InvalidStateError, which
    // reached the caller as "the microphone could not be started". The real
    // cause, a CSP that refused the blob: URL, appeared nowhere.
    addModuleError = error;
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = context.createMediaStreamSource(stream);
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(context, 'mindpal-pcm-capture');
  } catch (error) {
    stream.getAudioTracks().forEach((track) => track.stop());
    if (ownsContext) await context.close().catch(() => {});
    throw new CaptureWorkletError(addModuleError ?? error);
  }
  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onFrame(new Int16Array(event.data.pcm), event.data.rms);
  };
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  if (context.state === 'suspended') {
    await context.resume();
  }

  const notifyLost = options?.onDeviceLost;
  const onTrackEnded = () => notifyLost?.('track_ended');
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', onTrackEnded);
  });
  const onDeviceChange = () => {
    if (stream.getAudioTracks().some((track) => track.readyState === 'ended')) {
      notifyLost?.('devicechange');
    }
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

  return {
    context,
    stream,
    node,
    stop: async () => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      sink.disconnect();
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      stream.getAudioTracks().forEach((track) => {
        track.removeEventListener('ended', onTrackEnded);
        track.stop();
      });
      if (ownsContext && context.state !== 'closed') {
        await context.close();
      }
    },
  };
}

/** Exposed so a contract test can prove the worklet and `resample.ts` agree. */
export const CAPTURE_WORKLET_SOURCE = WORKLET_SOURCE;
