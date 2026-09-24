import { JitterTarget, pcm16ToFloat } from './playbackCore.ts';
import { PLAYBACK_PROCESSOR, PLAYBACK_WORKLET_SOURCE } from './playbackWorklet.ts';

const PLAYBACK_RATE = 24000;
/** Audio resuming within this long of running dry means the stream was starved, not finished. */
export const RESUMED_GAP_MS = 600;
/**
 * How much model audio may sit in the playback node at once. Enough to ride out
 * network jitter, far less than the ring, so a fast generation queues on the
 * main thread instead of overrunning the node.
 */
const STREAM_HIGH_WATER_MS = 2500;

/** What the playback worklet posts back. */
interface StreamMessage {
  type: string;
  queued?: number;
  queuedMs?: number;
  overflow?: number;
  rate?: number;
}
const PREBUFFER_SECONDS = 0.07;
/** ~48 ms equal-power fade: still feels like a yield, long enough to hide a mid-phoneme chop. */
/**
 * Barge-in taper.
 *
 * 48 ms was chosen to "still feel like a yield", but at that length it reads as
 * a hard cut - the caller says MindPal stops "with no fade, not like real life".
 * People trail off over roughly 150-250 ms when interrupted. This is long enough
 * to hear as yielding and short enough that the floor still changes hands fast.
 */
export const FADE_SECONDS = 0.2;
/** Conversational PCM RMS is often ~0.02–0.18; map into a 0–1 face envelope. */
export const SPEECH_RMS_REF = 0.11;
const TONE_TICK_MS = 50;
const IDLE_DEBOUNCE_MS = 120;

export interface PlaybackTone {
  rms: number;
  envelope: number;
  brightness: number;
  playing: boolean;
}

export function equalPowerFadeOut(from = 1, steps = 25): Float32Array {
  const start = Math.max(0, Math.min(1, from));
  const curve = new Float32Array(Math.max(2, steps));
  const last = curve.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const t = i / last;
    // Raised-cosine to 0, then squared for a slightly longer perceptual tail.
    const cosine = Math.cos((Math.PI / 2) * t);
    curve[i] = start * cosine * cosine;
  }
  curve[last] = 0;
  return curve;
}

export function pcm16Rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / pcm.length);
}

/** High-frequency energy share from PCM. Brightness of voice, not an emotion label. */
export function pcm16Brightness(pcm: Int16Array): number {
  if (pcm.length < 2) return 0.5;
  let energy = 0;
  let high = 0;
  for (let i = 1; i < pcm.length; i += 1) {
    const sample = pcm[i] / 0x8000;
    const delta = (pcm[i] - pcm[i - 1]) / 0x8000;
    energy += sample * sample;
    high += delta * delta;
  }
  if (energy < 1e-8) return 0.5;
  return Math.min(1, Math.max(0, high / (energy * 4)));
}

export function scaleSpeechRms(rms: number, ref = SPEECH_RMS_REF): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.max(0, Math.tanh((rms / Math.max(0.018, ref)) * 0.82)));
}

export function stepEnvelope(current: number, target: number, attack = 0.28, release = 0.12): number {
  const coeff = target > current ? attack : release;
  return current + (target - current) * coeff;
}

export function fadeDiscontinuity(curve: Float32Array): number {
  let maxDelta = 0;
  for (let i = 1; i < curve.length; i += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(curve[i] - curve[i - 1]));
  }
  return maxDelta;
}

export class PlaybackQueue {
  private context: AudioContext | null = null;
  private ownsContext = true;
  private gain: GainNode | null = null;
  private generation = 0;
  private gated = false;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: Int16Array[] = [];
  private started = false;
  private fading = false;
  private playedSamples = 0;
  private lastRms = 0;
  private envelope = 0;
  private brightness = 0.5;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private toneTimer: ReturnType<typeof setInterval> | null = null;
  private onFadeComplete: (() => void) | null;
  private onTone: ((tone: PlaybackTone) => void) | null;
  private onIdle: (() => void) | null;
  private overlayGain: GainNode | null = null;
  private overlaySources = new Set<AudioBufferSourceNode>();
  private overlayUntil = 0;
  /**
   * Continuous playback node. When present, PCM streams through one resampler
   * and one ring for the whole call. `sources` stays as the fallback for
   * browsers where worklet registration fails — and for the headless tests,
   * which have no AudioContext at all.
   */
  private streamNode: AudioWorkletNode | null = null;
  private streamQueued = 0;
  /**
   * Flow control. The model generates far faster than real time, so a whole
   * reply can arrive in a few seconds. Posting all of it at once overran the
   * worklet ring and dropped audio mid-sentence - the speech "compressing and
   * bursting". Chunks now wait in `pending` until the node has room.
   */
  private streamQueuedMs = 0;
  private streamOverflow = 0;
  private warnedFallback = false;
  private jitter = new JitterTarget();
  private underruns = 0;
  /** When the node last ran out mid-quantum. A real gap only if audio resumes soon after. */
  private ranDryAt = 0;

  private onEvent: ((event: string, data?: Record<string, unknown>) => void) | null;

  constructor(options?: {
    onFadeComplete?: () => void;
    onTone?: (tone: PlaybackTone) => void;
    onIdle?: () => void;
    /** Diagnostics hook. Underruns and overflows are invisible otherwise. */
    onEvent?: (event: string, data?: Record<string, unknown>) => void;
  }) {
    this.onFadeComplete = options?.onFadeComplete ?? null;
    this.onTone = options?.onTone ?? null;
    this.onIdle = options?.onIdle ?? null;
    this.onEvent = options?.onEvent ?? null;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get isGated(): boolean {
    return this.gated;
  }

  get isFading(): boolean {
    return this.fading;
  }

  isPlaying(): boolean {
    return this.sources.size > 0 || this.streamQueued > 0 || this.pending.length > 0 || this.fading;
  }

  /** Observability for the audio path: how often the stream starved, and the current target. */
  jitterSnapshot(): { targetMs: number; underruns: number; queuedSamples: number; streaming: boolean } {
    return {
      targetMs: this.jitter.valueMs,
      underruns: this.underruns,
      queuedSamples: this.streamQueued,
      streaming: this.streamNode !== null,
    };
  }

  /**
   * Audio arrived right after the node ran dry: that was a gap in the middle of a
   * reply, which is audible, so widen the buffer. Every reply also ends with a
   * partly filled quantum; counting those grew the buffer 115 -> 250 ms over a few
   * normal turns and added that much delay before every reply.
   */
  private noteResumeAfterDry(): void {
    if (!this.ranDryAt || this.fading || this.gated) return;
    const gapMs = Date.now() - this.ranDryAt;
    this.ranDryAt = 0;
    if (gapMs > RESUMED_GAP_MS) return;
    this.underruns += 1;
    const target = this.jitter.noteUnderrun();
    this.streamNode?.port.postMessage({ type: 'prebuffer', ms: target });
    this.onEvent?.('underrun', { underruns: this.underruns, targetMs: Math.round(target), gapMs });
    console.info('[mindpal.voice] playback_underrun', { underruns: this.underruns, targetMs: Math.round(target), gapMs });
  }

  /** Audio queued but not yet heard, in ms. Text that arrives now is heard after this. */
  queuedMs(): number {
    const pendingMs = (this.pending.reduce((sum, chunk) => sum + chunk.length, 0) / PLAYBACK_RATE) * 1000;
    if (this.streamNode) return this.streamQueuedMs + pendingMs;
    const context = this.context;
    const scheduledMs = context ? Math.max(0, this.nextTime - context.currentTime) * 1000 : 0;
    return scheduledMs + pendingMs;
  }

  isOverlayPlaying(now = Date.now()): boolean {
    return this.overlaySources.size > 0 || now < this.overlayUntil;
  }

  lastEnvelope(): number {
    return this.envelope;
  }

  playbackTone(): PlaybackTone {
    return {
      rms: this.lastRms,
      envelope: this.envelope,
      brightness: this.brightness,
      playing: this.isPlaying(),
    };
  }

  playedMs(): number {
    return Math.round((this.playedSamples / PLAYBACK_RATE) * 1000);
  }

  async ensure(shared?: AudioContext): Promise<AudioContext> {
    if (this.context && this.context.state !== 'closed') {
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context;
    }
    const context = shared && shared.state !== 'closed' ? shared : new AudioContext({ latencyHint: 'interactive' });
    this.ownsContext = context === shared ? false : true;
    const gain = context.createGain();
    gain.connect(context.destination);
    const overlayGain = context.createGain();
    overlayGain.gain.value = 0.22;
    overlayGain.connect(context.destination);
    this.context = context;
    this.gain = gain;
    this.overlayGain = overlayGain;
    this.nextTime = context.currentTime;
    if (context.state === 'suspended') await context.resume();
    await this.ensureStreamNode(context, gain);
    return context;
  }

  /**
   * One continuous node for the call. Failure is not fatal: the per-chunk
   * scheduler below still works, it just carries the chunk-boundary artefacts
   * this node exists to remove.
   */
  private async ensureStreamNode(context: AudioContext, gain: GainNode): Promise<void> {
    if (this.streamNode) return;
    if (typeof AudioWorkletNode === 'undefined' || !context.audioWorklet) return;
    const blob = new Blob([PLAYBACK_WORKLET_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    let addModuleError = '';
    try {
      await context.audioWorklet.addModule(url);
    } catch (error) {
      // Swallowing this silently is how the continuous playback path ended up
      // inactive in production without anyone noticing: a trace showed
      // streaming:false while every worklet test passed. The reason has to
      // survive.
      addModuleError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      URL.revokeObjectURL(url);
    }
    try {
      const node = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent<StreamMessage>) => {
        this.onStreamMessage(event.data);
      };
      node.connect(gain);
      this.streamNode = node;
      node.port.postMessage({ type: 'prebuffer', ms: this.jitter.valueMs });
      this.onEvent?.('worklet_ready', { sampleRate: context.sampleRate });
    } catch (error) {
      this.streamNode = null;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.onEvent?.('worklet_failed', {
        addModuleError: addModuleError || null,
        nodeError: detail,
        contextState: context.state,
        sampleRate: context.sampleRate,
      });
      console.warn('[mindpal.voice] playback_worklet_failed', { addModuleError, detail });
    }
  }

  private onStreamMessage(message: StreamMessage): void {
    if (message.type === 'stats') {
      this.streamQueued = Math.max(0, message.queued ?? 0);
      this.streamQueuedMs = Math.max(0, message.queuedMs ?? 0);
      if ((message.overflow ?? 0) > this.streamOverflow) {
        this.streamOverflow = message.overflow ?? 0;
        this.onEvent?.('overflow', { dropped: this.streamOverflow });
        console.info('[mindpal.voice] playback_overflow', { dropped: this.streamOverflow });
      }
      this.jitter.noteClean();
      // Room freed up: hand over whatever is still waiting.
      if (this.pending.length && !this.fading && !this.gated) this.drainToStream();
      return;
    }
    if (message.type === 'underrun') {
      // Intentional interruption cuts or fades are not buffer starvations.
      if (this.fading || this.gated) return;
      // The node cannot tell a starved stream from one that simply ended: both
      // look like a partly filled last quantum. Judge it by what happens next.
      this.ranDryAt = Date.now();
      return;
    }
    if (message.type === 'faded') {
      // The node has tapered and emptied itself; nothing of the cut turn is left.
      this.streamQueued = 0;
      this.streamQueuedMs = 0;
      return;
    }
    if (message.type === 'drained') {
      this.streamQueued = 0;
      if (!this.fading) this.notifyIdle();
    }
  }

  enqueue(pcm: Int16Array, generation = this.generation): boolean {
    if (!pcm.length || this.gated || generation !== this.generation) return false;
    this.noteResumeAfterDry();
    this.lastRms = pcm16Rms(pcm);
    this.brightness = pcm16Brightness(pcm);
    this.clearIdleTimer();
    this.ensureToneTick();
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) {
      this.pending.push(pcm);
      return true;
    }
    this.pending.push(pcm);
    if (this.fading) return true;
    if (this.streamNode) {
      // The worklet owns the jitter buffer and adapts it to observed starvation.
      // Holding a second prebuffer here would just add fixed latency on top.
      this.started = true;
      this.drainToStream();
      return true;
    }
    if (!this.started) {
      const buffered = this.pending.reduce((sum, chunk) => sum + chunk.length, 0) / PLAYBACK_RATE;
      if (buffered < PREBUFFER_SECONDS) return true;
      this.started = true;
    }
    this.drainPending(context, gain);
    return true;
  }

  /**
   * A short opening greeting can sit under the 70ms prebuffer forever if the
   * model turn ends first. Generation-complete must start whatever is queued.
   */
  flushPrebuffer(): boolean {
    if (this.gated || this.fading) return false;
    if (this.streamNode) {
      // End of the model turn: play whatever is buffered, even under the target.
      this.drainToStream();
      this.streamNode.port.postMessage({ type: 'start' });
      return true;
    }
    if (!this.pending.length) return this.started;
    this.started = true;
    if (this.context && this.gain) this.drainPending(this.context, this.gain);
    return true;
  }

  /**
   * Ducked overlap in the session voice. Never the capture path, never a floor steal.
   * Returns false if there is no context or the clip is empty.
   */
  playOverlay(
    pcm: Int16Array,
    options?: { gain?: number; maxMs?: number; sampleRate?: number },
  ): { played: boolean; durationMs: number; captureBound: false } {
    const rate = options?.sampleRate || PLAYBACK_RATE;
    // Up to 700ms: a spoken "mm-hmm" is ~500ms. The old 400ms ceiling (and
    // the 280ms callers asked for) cut the word in half.
    const maxMs = Math.min(700, Math.max(80, options?.maxMs ?? 700));
    const maxSamples = Math.floor((maxMs / 1000) * rate);
    const clipped = pcm.length > maxSamples ? pcm.subarray(0, maxSamples) : pcm;
    if (!clipped.length || !this.context || !this.overlayGain) {
      return { played: false, durationMs: 0, captureBound: false };
    }
    const context = this.context;
    const gain = this.overlayGain;
    // Ramped, not switched. `setValueAtTime` starts and ends the clip at full
    // level, so a 280ms "mm" begins and ends on a step - which is what makes it
    // sound pasted in rather than murmured. A short rise and a longer fall is
    // roughly the envelope of a real one.
    const peak = Math.min(0.9, Math.max(0.08, options?.gain ?? 0.3));
    const now = context.currentTime;
    const durationS = clipped.length / rate;
    const attackS = Math.min(0.05, durationS * 0.25);
    const releaseS = Math.min(0.09, durationS * 0.35);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + attackS);
    gain.gain.setValueAtTime(peak, now + Math.max(attackS, durationS - releaseS));
    // Exponential cannot reach zero, so land just below audibility.
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);
    const buffer = context.createBuffer(1, clipped.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < clipped.length; i += 1) {
      channel[i] = clipped[i] / 0x8000;
    }
    const durationMs = durationS * 1000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      this.overlaySources.delete(source);
    };
    source.start(now);
    this.overlaySources.add(source);
    this.overlayUntil = Date.now() + durationMs;
    return { played: true, durationMs, captureBound: false };
  }

  /**
   * Let an overlay clip fade out instead of cutting it.
   *
   * Used when a real reply starts while an acknowledgment is still sounding: the
   * "mm" gives way over a few tens of milliseconds rather than overlapping the
   * first word of the answer or stopping on a click.
   */
  fadeOverlay(ms = 80): void {
    if (!this.context || !this.overlayGain || !this.overlaySources.size) return;
    const now = this.context.currentTime;
    const gain = this.overlayGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(0.0001, gain.value), now);
    gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);
    const sources = [...this.overlaySources];
    globalThis.setTimeout(() => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
      }
    }, ms + 20);
    this.overlayUntil = Date.now() + ms;
  }

  stopOverlay(): void {
    this.overlaySources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
    });
    this.overlaySources.clear();
    this.overlayUntil = 0;
  }

  /**
   * Fade out the current generation and arm the leftover-PCM fence.
   * Fade-complete must not drain pending: post-flush chunks of the cut sentence
   * would otherwise resume after the user interrupted.
   */
  flush(): number {
    this.generation += 1;
    this.gated = true;
    // Cut off on purpose: running dry now is not starvation.
    this.ranDryAt = 0;
    const playedMs = this.playedMs();
    const context = this.context;
    const gain = this.gain;
    this.pending = [];
    this.started = false;
    this.fading = true;
    this.lastRms = 0;
    this.clearFadeTimer();
    this.clearIdleTimer();
    this.ensureToneTick();
    if (!context || !gain) {
      this.streamQueued = 0;
      this.streamQueuedMs = 0;
      this.fading = false;
      this.envelope = 0;
      this.emitTone();
      this.onFadeComplete?.();
      this.notifyIdle();
      return playedMs;
    }
    const now = context.currentTime;
    if (this.streamNode) {
      // The node tapers its own samples and clears itself afterwards, so the
      // gain never has to be restored while audio is still queued.
      this.streamNode.port.postMessage({
        type: 'fade',
        ms: FADE_SECONDS * 1000,
        generation: this.generation,
      });
    } else {
      const from = Math.max(0.0001, gain.gain.value);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(from, now);
      gain.gain.setValueCurveAtTime(equalPowerFadeOut(from), now, FADE_SECONDS);
    }
    this.fadeTimer = globalThis.setTimeout(() => {
      this.fadeTimer = null;
      this.finishFade();
    }, Math.ceil(FADE_SECONDS * 1000) + 2);
    return playedMs;
  }

  /** End a flush's fade: stop what was playing and return to a clean, idle state. */
  private finishFade(): void {
    this.clearFadeTimer();
    if (!this.fading) return;
    const context = this.context;
    const gain = this.gain;
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
    });
    this.sources.clear();
    // Drop everything the continuous node is still holding for the cut turn.
    // The generation stamp makes any in-flight postMessage a no-op on arrival.
    this.streamQueued = 0;
    this.streamQueuedMs = 0;
    if (context && gain && !this.streamNode) {
      // Only the fallback path ramped the gain, so only it needs restoring.
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(1, context.currentTime);
    }
    if (context) this.nextTime = context.currentTime;
    this.fading = false;
    this.pending = [];
    this.started = false;
    this.notifyIdle();
    this.onFadeComplete?.();
  }

  /**
   * Open the next model turn after leftover PCM of the interrupted generation is dead.
   *
   * Finishes a fade still in progress first. Released mid-fade, the fade timer
   * used to find a newer generation and bail out, leaving `fading` set forever:
   * every later chunk was queued behind it and nothing played again. A trace
   * shows exactly that: an interrupt, `turn_complete` 5ms later, and the next
   * reply generated in full but never heard.
   */
  releaseFence(): number {
    if (this.fading) this.finishFade();
    this.gated = false;
    this.pending = [];
    this.started = false;
    this.generation += 1;
    this.streamQueued = 0;
    this.streamNode?.port.postMessage({ type: 'generation', generation: this.generation });
    return this.generation;
  }

  async dispose(): Promise<void> {
    this.flush();
    this.clearFadeTimer();
    this.clearIdleTimer();
    this.clearToneTimer();
    this.stopOverlay();
    if (this.streamNode) {
      this.streamNode.port.onmessage = null;
      try {
        this.streamNode.disconnect();
      } catch {
        /* already detached */
      }
      this.streamNode = null;
    }
    this.streamQueued = 0;
    this.streamQueuedMs = 0;
    this.jitter.reset();
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.overlayGain = null;
    if (this.ownsContext && context && context.state !== 'closed') {
      await context.close();
    }
  }

  private drainPending(context: AudioContext, gain: GainNode): void {
    if (this.streamNode) {
      this.drainToStream();
      return;
    }
    // Per-chunk scheduling. Only reached when the worklet failed to load, and it
    // carries the artefacts the worklet exists to remove.
    if (!this.warnedFallback) {
      this.warnedFallback = true;
      this.onEvent?.('fallback_path_active', { reason: 'no worklet node' });
    }
    const gen = this.generation;
    while (this.pending.length) {
      const pcm = this.pending.shift();
      if (!pcm) break;
      if (gen !== this.generation || this.fading) return;
      this.playedSamples += pcm.length;
      this.lastRms = pcm16Rms(pcm);
      this.brightness = pcm16Brightness(pcm);
      const buffer = context.createBuffer(1, pcm.length, PLAYBACK_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) {
        channel[i] = pcm[i] / 0x8000;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const startAt = Math.max(this.nextTime, context.currentTime);
      source.onended = () => {
        if (gen !== this.generation) return;
        this.sources.delete(source);
        if (!this.sources.size && !this.pending.length && !this.fading) {
          this.notifyIdle();
        }
      };
      source.start(startAt);
      this.sources.add(source);
      this.nextTime = startAt + buffer.duration;
    }
  }

  /**
   * Hand every queued chunk to the continuous node. Samples are transferred, not
   * copied, so this stays allocation-light at 50 chunks/second.
   */
  private drainToStream(): void {
    const node = this.streamNode;
    if (!node) return;
    const gen = this.generation;
    while (this.pending.length) {
      // Stop at the high-water mark. Anything past it stays in `pending` and
      // goes over on the next stats message, so the ring cannot overrun.
      if (this.streamQueuedMs >= STREAM_HIGH_WATER_MS) break;
      const pcm = this.pending.shift();
      if (!pcm) break;
      if (gen !== this.generation || this.fading) return;
      this.playedSamples += pcm.length;
      this.lastRms = pcm16Rms(pcm);
      this.brightness = pcm16Brightness(pcm);
      const samples = pcm16ToFloat(pcm);
      // Main-thread estimate between stats messages, so isPlaying() stays honest
      // and the high-water check does not overshoot within one drain.
      this.streamQueued += samples.length;
      this.streamQueuedMs += (samples.length / PLAYBACK_RATE) * 1000;
      node.port.postMessage(
        { type: 'pcm', generation: gen, samples: samples.buffer },
        [samples.buffer],
      );
    }
    // No 'start' here. It used to follow every chunk, which told the worklet to
    // play at once and skipped its adaptive prebuffer: audio arriving at about
    // real-time pace ran dry between chunks (the playback_underrun spam) and
    // raising the jitter target changed nothing. The worklet starts itself once
    // the target is buffered; flushPrebuffer() starts a short tail at turn end.
  }

  private notifyIdle(): void {
    if (!this.onIdle) {
      this.lastRms = 0;
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      if (this.sources.size || this.streamQueued || this.pending.length || this.fading) return;
      this.lastRms = 0;
      this.onIdle?.();
    }, IDLE_DEBOUNCE_MS);
  }

  private ensureToneTick(): void {
    if (!this.onTone || this.toneTimer !== null) return;
    this.toneTimer = globalThis.setInterval(() => {
      const active = this.sources.size > 0 || this.streamQueued > 0 || this.pending.length > 0;
      const target = this.fading || !active ? 0 : scaleSpeechRms(this.lastRms);
      const attack = this.fading ? 0.45 : 0.28;
      const release = this.fading ? 0.35 : 0.12;
      this.envelope = stepEnvelope(this.envelope, target, attack, release);
      if (!active && !this.fading) this.lastRms *= 0.65;
      this.emitTone();
      if (this.envelope < 0.008 && !active && !this.fading) {
        this.envelope = 0;
        this.clearToneTimer();
        this.emitTone();
      }
    }, TONE_TICK_MS);
  }

  private emitTone(): void {
    this.onTone?.(this.playbackTone());
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer === null) return;
    globalThis.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    globalThis.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearToneTimer(): void {
    if (this.toneTimer === null) return;
    globalThis.clearInterval(this.toneTimer);
    this.toneTimer = null;
  }
}
